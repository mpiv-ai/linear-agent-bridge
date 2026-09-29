import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { parseCanonicalRecoveryKey } from "./state/recovery-envelope.js";
import { DEFAULT_RECEIPT_RETENTION_MS } from "./state/store.js";

export interface Config {
  linearClientId: string;
  linearClientSecret: string;
  linearWebhookSecret: string;
  /**
   * Optional bootstrap value for the Linear access token. Once the OAuth
   * callback has run, the rotating pair in oauthTokenStorePath supersedes it.
   * Unset means authorization has not completed yet; the service still boots
   * and prints its authorization URL rather than requiring a placeholder.
   */
  linearAccessToken?: string;
  port: number;
  /**
   * Must match the redirect URI registered on the Linear OAuth2 Application
   * and passed to both /oauth/authorize and the token exchange. Defaults to
   * localhost on the configured port; override for a non-default local port
   * behind a fixed hostname, or for a tunneled/remote deployment where the
   * public host differs from where the bridge actually listens.
   */
  oauthRedirectUri: string;
  /**
   * Runtime for this app: claude or codex. Additional apps from
   * BRIDGE_APPS_FILE choose theirs with `target`.
   */
  runtime: "claude" | "codex";
  /** Additional-app id from BRIDGE_APPS_FILE; unset for the default app. */
  appId?: string;
  /**
   * How this app gets its Linear token. Unset is the authorization-code
   * flow with a rotating pair (the default app). Client-credentials
   * apps use the client_credentials grant and have no authorization URL or callback.
   */
  linearAuth?: "authorization_code" | "client_credentials";
  /** Delegation records for a client-credentials app. */
  delegationStorePath?: string;
  /**
   * This app's Linear app user id. When set, an AgentSessionEvent whose
   * `appUserId` disagrees is rejected (LINEAR_APP_USER_ID for the default
   * app).
   */
  appUserId?: string;
  kbPath: string;
  sessionStorePath: string;
  bridgeStateStorePath: string;
  oauthTokenStorePath: string;
  runInactivityTimeoutMs: number;
  progressNoticeIntervalMs: number;
  ingressRecoveryKey: string;
  ingressRecoveryPreviousKeys: string[];
  reconcileIntervalMs: number;
  reconcileLookbackMs: number;
  reconcileMaxSessions: number;
  agentSessionAckGraceMs: number;
  /**
   * Optional Linear issue-label id that grants autonomous execution. Unset
   * preserves the one-provider-turn behavior from v0.2.x.
   */
  autonomousGoalLabelId?: string;
  autonomousGoalMaxSteps: number;
  /**
   * Directory the agent may write to. Optional: unset means the runtime keeps
   * today's behaviour and no output path is surfaced. Enforcement is the
   * filesystem, never this value; surfacing it only saves the agent from
   * discovering the boundary by hitting EACCES.
   */
  agentOutputPath?: string;
  shutdownTimeoutMs: number;
}

const DEFAULT_PORT = "3979";
const DEFAULT_RUNTIME = "claude";
const DEFAULT_SESSION_STORE_PATH = "./data/sessions.json";
const DEFAULT_BRIDGE_STATE_STORE_PATH = "./data/bridge-state.json";
const DEFAULT_OAUTH_TOKEN_STORE_PATH = "./data/oauth-tokens.json";
const DEFAULT_RUN_INACTIVITY_TIMEOUT_MS = "300000";
const DEFAULT_PROGRESS_NOTICE_INTERVAL_MS = "120000";
const DEFAULT_RECONCILE_INTERVAL_MS = "60000";
const DEFAULT_RECONCILE_LOOKBACK_MS = "86400000";
const DEFAULT_RECONCILE_MAX_SESSIONS = "250";
const DEFAULT_AGENT_SESSION_ACK_GRACE_MS = "120000";
const DEFAULT_AUTONOMOUS_GOAL_MAX_STEPS = "8";
// Chosen to sit inside launchd's 20-second SIGKILL window. systemd's default
// TimeoutStopSec is far longer, so the same default is safe there.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = "10000";
let warnedAboutDeprecatedRunTimeout = false;

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function positiveInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${key} "${value}": expected a positive integer`);
  }
  return parsed;
}

function parseRecoveryKeys(
  primary: string,
  previousRaw: string | undefined,
): string[] {
  if (parseCanonicalRecoveryKey(primary) === undefined) {
    throw new Error(
      "Invalid INGRESS_RECOVERY_KEY: expected canonical 32-byte base64url",
    );
  }
  const previous =
    previousRaw === undefined || previousRaw === ""
      ? []
      : previousRaw.split(",");
  if (
    previous.length > 4 ||
    previous.some((value) => parseCanonicalRecoveryKey(value) === undefined) ||
    new Set([primary, ...previous]).size !== previous.length + 1
  ) {
    throw new Error(
      "Invalid INGRESS_RECOVERY_PREVIOUS_KEYS: expected up to four unique canonical 32-byte base64url keys",
    );
  }
  return previous;
}

function integerInRange(
  value: string,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Invalid ${key} "${value}": expected an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

const OAUTH_CALLBACK_PATH = "/oauth/callback";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Resolve and validate OAUTH_REDIRECT_URI. Unset derives the same
 * http://localhost:<PORT>/oauth/callback the bridge always used, but keyed
 * off the configured PORT instead of a fixed value, so a non-default local
 * port no longer produces a redirect URI Linear will refuse. An explicit
 * value is only checked for the port/URI mismatches that are unambiguous:
 * a malformed URL, a path other than the one the server actually routes, or
 * a loopback host whose port disagrees with PORT. A non-loopback host (a
 * tunnel or a separately fronted public hostname) is left alone, since the
 * bridge does not control what port that host forwards from.
 */
function resolveOauthRedirectUri(
  value: string | undefined,
  port: number,
): string {
  if (value === undefined || value === "") {
    return `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `Invalid OAUTH_REDIRECT_URI "${value}": expected a valid absolute URL`,
    );
  }

  if (parsed.pathname !== OAUTH_CALLBACK_PATH) {
    throw new Error(
      `Invalid OAUTH_REDIRECT_URI "${value}": path must be "${OAUTH_CALLBACK_PATH}" to match the bridge's callback route`,
    );
  }

  if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    const declaredPort =
      parsed.port === ""
        ? parsed.protocol === "https:"
          ? 443
          : 80
        : Number(parsed.port);
    if (declaredPort !== port) {
      throw new Error(
        `Invalid OAUTH_REDIRECT_URI "${value}": port ${declaredPort} does not match configured PORT ${port}`,
      );
    }
  }

  return value;
}

function optionalLinearId(
  value: string | undefined,
  key: string,
): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (
    value.length > 256 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`Invalid ${key}: expected a Linear UUID`);
  }
  return value;
}

/**
 * Load and validate config from process.env (see .env.example).
 * Missing required values fail fast, naming the first missing variable
 * in declared order: LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET,
 * LINEAR_WEBHOOK_SECRET, INGRESS_RECOVERY_KEY. LINEAR_ACCESS_TOKEN is an
 * optional bootstrap value: unset means OAuth authorization has not
 * completed yet, and the service still boots to print its authorization URL.
 */
/**
 * Validate the output path once, at startup, so a misconfiguration surfaces
 * before a turn is accepted rather than half way through one.
 */
export function resolveAgentOutputPath(value: string, label = "AGENT_OUTPUT_PATH"): string {
  const resolved = path.resolve(value);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    try {
      mkdirSync(resolved, { recursive: true, mode: 0o700 });
    } catch {
      throw new Error(
        `Invalid ${label} "${resolved}": could not be created`,
      );
    }
    return resolved;
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `Invalid ${label} "${resolved}": expected a directory`,
    );
  }
  try {
    accessSync(resolved, constants.W_OK);
  } catch {
    throw new Error(`Invalid ${label} "${resolved}": not writable`);
  }
  return resolved;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const linearClientId = requireEnv(env, "LINEAR_CLIENT_ID");
  const linearClientSecret = requireEnv(env, "LINEAR_CLIENT_SECRET");
  const linearWebhookSecret = requireEnv(env, "LINEAR_WEBHOOK_SECRET");
  const linearAccessTokenRaw = env.LINEAR_ACCESS_TOKEN;
  const linearAccessToken =
    linearAccessTokenRaw === undefined || linearAccessTokenRaw === ""
      ? undefined
      : linearAccessTokenRaw;
  const ingressRecoveryKey = requireEnv(env, "INGRESS_RECOVERY_KEY");
  const ingressRecoveryPreviousKeys = parseRecoveryKeys(
    ingressRecoveryKey,
    env.INGRESS_RECOVERY_PREVIOUS_KEYS,
  );
  const autonomousGoalLabelId = optionalLinearId(
    env.AUTONOMOUS_GOAL_LABEL_ID,
    "AUTONOMOUS_GOAL_LABEL_ID",
  );
  const appUserId = optionalLinearId(env.LINEAR_APP_USER_ID, "LINEAR_APP_USER_ID");

  const runtimeRaw = env.RUNTIME ?? DEFAULT_RUNTIME;
  if (runtimeRaw !== "claude" && runtimeRaw !== "codex") {
    throw new Error(`Invalid RUNTIME "${runtimeRaw}": expected "claude" or "codex"`);
  }

  const portRaw = env.PORT ?? DEFAULT_PORT;
  const port = positiveInteger(portRaw, "PORT");
  const oauthRedirectUri = resolveOauthRedirectUri(
    env.OAUTH_REDIRECT_URI,
    port,
  );
  let inactivityTimeoutRaw = env.RUN_INACTIVITY_TIMEOUT_MS;
  let inactivityTimeoutKey = "RUN_INACTIVITY_TIMEOUT_MS";
  if (env.RUN_TIMEOUT_MS !== undefined && !warnedAboutDeprecatedRunTimeout) {
    warnedAboutDeprecatedRunTimeout = true;
    console.warn(
      "[linear-agent-bridge] RUN_TIMEOUT_MS is deprecated; use RUN_INACTIVITY_TIMEOUT_MS instead.",
    );
  }
  if (inactivityTimeoutRaw === undefined && env.RUN_TIMEOUT_MS !== undefined) {
    inactivityTimeoutRaw = env.RUN_TIMEOUT_MS;
    inactivityTimeoutKey = "RUN_TIMEOUT_MS";
  }
  const runInactivityTimeoutMs = positiveInteger(
    inactivityTimeoutRaw ?? DEFAULT_RUN_INACTIVITY_TIMEOUT_MS,
    inactivityTimeoutKey,
  );
  const progressNoticeIntervalMs = positiveInteger(
    env.PROGRESS_NOTICE_INTERVAL_MS ?? DEFAULT_PROGRESS_NOTICE_INTERVAL_MS,
    "PROGRESS_NOTICE_INTERVAL_MS",
  );

  const agentOutputPathRaw = env.AGENT_OUTPUT_PATH;
  const reconcileLookbackMs = positiveInteger(
    env.RECONCILE_LOOKBACK_MS ?? DEFAULT_RECONCILE_LOOKBACK_MS,
    "RECONCILE_LOOKBACK_MS",
  );
  // Recovering a lost created webhook depends on the created claim still being
  // there to deduplicate against. Retention shorter than the reconcile window
  // would let that claim age out first, and recovery would then re-run an
  // opening prompt that already ran.
  if (reconcileLookbackMs > DEFAULT_RECEIPT_RETENTION_MS) {
    throw new Error(
      `Invalid RECONCILE_LOOKBACK_MS "${reconcileLookbackMs}": must not exceed durable state retention of ${DEFAULT_RECEIPT_RETENTION_MS}ms`,
    );
  }

  const shutdownTimeoutMs = positiveInteger(
    env.SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    "SHUTDOWN_TIMEOUT_MS",
  );

  return {
    ...(autonomousGoalLabelId !== undefined ? { autonomousGoalLabelId } : {}),
    ...(appUserId !== undefined ? { appUserId } : {}),
    autonomousGoalMaxSteps: integerInRange(
      env.AUTONOMOUS_GOAL_MAX_STEPS ?? DEFAULT_AUTONOMOUS_GOAL_MAX_STEPS,
      "AUTONOMOUS_GOAL_MAX_STEPS",
      1,
      100,
    ),
    ...(agentOutputPathRaw !== undefined && agentOutputPathRaw !== ""
      ? { agentOutputPath: resolveAgentOutputPath(agentOutputPathRaw) }
      : {}),
    shutdownTimeoutMs,
    linearClientId,
    linearClientSecret,
    linearWebhookSecret,
    ...(linearAccessToken !== undefined ? { linearAccessToken } : {}),
    port,
    oauthRedirectUri,
    runtime: runtimeRaw,
    // The directory agent sessions run in — its CLAUDE.md stack and any
    // project-scope MCP config load automatically. Defaults to the
    // service's own working directory; point it at your knowledge base.
    kbPath: env.KB_PATH ?? process.cwd(),
    sessionStorePath: env.SESSION_STORE_PATH ?? DEFAULT_SESSION_STORE_PATH,
    bridgeStateStorePath:
      env.BRIDGE_STATE_STORE_PATH ?? DEFAULT_BRIDGE_STATE_STORE_PATH,
    oauthTokenStorePath:
      env.OAUTH_TOKEN_STORE_PATH ?? DEFAULT_OAUTH_TOKEN_STORE_PATH,
    runInactivityTimeoutMs,
    progressNoticeIntervalMs,
    ingressRecoveryKey,
    ingressRecoveryPreviousKeys,
    reconcileIntervalMs: positiveInteger(
      env.RECONCILE_INTERVAL_MS ?? DEFAULT_RECONCILE_INTERVAL_MS,
      "RECONCILE_INTERVAL_MS",
    ),
    reconcileLookbackMs,
    reconcileMaxSessions: integerInRange(
      env.RECONCILE_MAX_SESSIONS ?? DEFAULT_RECONCILE_MAX_SESSIONS,
      "RECONCILE_MAX_SESSIONS",
      1,
      250,
    ),
    agentSessionAckGraceMs: positiveInteger(
      env.AGENT_SESSION_ACK_GRACE_MS ?? DEFAULT_AGENT_SESSION_ACK_GRACE_MS,
      "AGENT_SESSION_ACK_GRACE_MS",
    ),
  };
}
