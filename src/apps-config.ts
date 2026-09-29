import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { resolveAgentOutputPath, type Config } from "./config.js";

/**
 * Additional Linear apps served by the same bridge process.
 *
 * The env-configured app stays the default app and behaves exactly as
 * before. `BRIDGE_APPS_FILE` names a JSON file that adds more apps, each
 * with its own OAuth client, webhook signing secret, token store, durable
 * state, and target runtime. Secrets are never inline: every secret is a
 * `*File` path or a `*Env` variable name, resolved at startup.
 *
 * {
 *   "apps": [{
 *     "id": "builder",
 *     "clientId": "<linear oauth client id>",
 *     "clientSecretFile": "/etc/linear-agent-bridge/apps/builder-client-secret",
 *     "webhookSecretFile": "/etc/linear-agent-bridge/apps/builder-webhook-secret",
 *     "auth": "client_credentials",
 *     "appUserId": "<linear app user uuid>",
 *     "target": "claude",
 *     "stateDir": "/var/lib/linear-agent-bridge/apps/builder",
 *     "kbPath": "/srv/builder-checkout",
 *     "agentOutputPath": "/srv/builder-output"
 *   }]
 * }
 *
 * Each app names `clientId` plus `clientSecretFile`/`Env` and
 * `webhookSecretFile`/`Env`. `target` is "claude" or "codex". `kbPath` and
 * `agentOutputPath` are optional absolute paths; unset, the app uses the
 * default app's `KB_PATH` and `AGENT_OUTPUT_PATH`. `agentOutputPath` is
 * checked the way `AGENT_OUTPUT_PATH` is: created if missing, then required
 * to be a writable directory. An app that
 * cannot be configured stops startup with an error naming the app.
 */
export type AppTarget = { kind: "claude" } | { kind: "codex" };

export interface AdditionalApp {
  id: string;
  target: AppTarget;
  /** The Linear app user id, used to address this app as a delegate. */
  appUserId?: string | undefined;
  config: Config;
}

export interface AppsConfig {
  apps: AdditionalApp[];
}

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INLINE_SECRET_KEYS = [
  "clientSecret",
  "webhookSecret",
  "accessToken",
  "apiKey",
] as const;

export function parseAppTarget(value: unknown, where: string): AppTarget {
  if (value === "claude" || value === "codex") {
    return { kind: value };
  }
  throw new Error(`Invalid ${where}.target: expected "claude" or "codex"`);
}

/**
 * Load `BRIDGE_APPS_FILE`, if set. Unset returns no additional apps, which
 * is the legacy single-app configuration.
 */
export function loadAppsConfig(
  base: Config,
  env: NodeJS.ProcessEnv = process.env,
): AppsConfig {
  const file = env.BRIDGE_APPS_FILE;
  if (file === undefined || file === "") {
    return { apps: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Invalid BRIDGE_APPS_FILE "${file}": expected readable JSON`);
  }
  return parseAppsConfig(raw, base, env);
}

export function parseAppsConfig(
  raw: unknown,
  base: Config,
  env: NodeJS.ProcessEnv = process.env,
): AppsConfig {
  const root = asRecord(raw);
  if (root === undefined || !Array.isArray(root.apps)) {
    throw new Error('Invalid BRIDGE_APPS_FILE: expected an object with an "apps" array');
  }

  const seenIds = new Set<string>(["default"]);
  const seenClientIds = new Set<string>([base.linearClientId]);
  const seenWebhookSecrets = new Set<string>([base.linearWebhookSecret]);
  const seenPaths = new Set<string>(
    [base.sessionStorePath, base.bridgeStateStorePath, base.oauthTokenStorePath].map(
      (value) => path.resolve(value),
    ),
  );

  const apps: AdditionalApp[] = root.apps.map((entry: unknown, index) => parseApp(entry, index));

  function parseApp(entry: unknown, index: number): AdditionalApp {
    const where = `apps[${index}]`;
    const app = asRecord(entry);
    if (app === undefined) {
      throw new Error(`Invalid ${where}: expected an object`);
    }
    for (const key of INLINE_SECRET_KEYS) {
      if (key in app) {
        throw new Error(
          `Invalid ${where}.${key}: secrets must be referenced with ${key}File or ${key}Env, never inline`,
        );
      }
    }
    const id = app.id;
    if (typeof id !== "string" || !APP_ID_PATTERN.test(id) || seenIds.has(id)) {
      throw new Error(
        `Invalid ${where}.id: expected a unique lowercase slug other than "default"`,
      );
    }
    seenIds.add(id);

    const clientId = requireString(app.clientId, `${where}.clientId`);
    if (seenClientIds.has(clientId)) {
      throw new Error(`Invalid ${where}.clientId: each app needs its own OAuth client`);
    }
    seenClientIds.add(clientId);

    const clientSecret = resolveSecret(app, "clientSecret", where, env);
    const webhookSecret = resolveSecret(app, "webhookSecret", where, env);
    if (
      app.auth !== undefined &&
      app.auth !== "authorization_code" &&
      app.auth !== "client_credentials"
    ) {
      throw new Error(
        `Invalid ${where}.auth: expected "authorization_code" or "client_credentials"`,
      );
    }
    const linearAuth = app.auth as Config["linearAuth"];
    if (seenWebhookSecrets.has(webhookSecret)) {
      throw new Error(
        `Invalid ${where}.webhookSecret: each app needs its own webhook signing secret`,
      );
    }
    seenWebhookSecrets.add(webhookSecret);

    const target = parseAppTarget(app.target, where);
    const appUserId =
      app.appUserId === undefined
        ? undefined
        : requireUuid(app.appUserId, `${where}.appUserId`);

    const stateDir = requireString(app.stateDir, `${where}.stateDir`);
    if (!path.isAbsolute(stateDir)) {
      throw new Error(`Invalid ${where}.stateDir: expected an absolute path`);
    }
    const sessionStorePath = path.join(stateDir, "sessions.json");
    const bridgeStateStorePath = path.join(stateDir, "bridge-state.json");
    const oauthTokenStorePath = path.join(stateDir, "oauth-tokens.json");
    for (const statePath of [sessionStorePath, bridgeStateStorePath, oauthTokenStorePath]) {
      if (seenPaths.has(statePath)) {
        throw new Error(`Invalid ${where}.stateDir: state paths must not be shared between apps`);
      }
      seenPaths.add(statePath);
    }

    // Each agent's working directory is what gives it its context, so an app
    // may name its own; unset keeps the default app's.
    const kbPath = optionalAbsolutePath(app.kbPath, `${where}.kbPath`);
    const agentOutputPathRaw = optionalAbsolutePath(app.agentOutputPath, `${where}.agentOutputPath`);
    const agentOutputPath =
      agentOutputPathRaw === undefined
        ? undefined
        : resolveAgentOutputPath(agentOutputPathRaw, `${where}.agentOutputPath`);

    const oauthRedirectUri =
      app.oauthRedirectUri === undefined
        ? base.oauthRedirectUri
        : requireString(app.oauthRedirectUri, `${where}.oauthRedirectUri`);

    const {
      linearAccessToken: _bootstrapToken,
      autonomousGoalLabelId: _goalLabel,
      appUserId: _defaultAppUser,
      linearAuth: _defaultAuth,
      ...inherited
    } = base;
    const config: Config = {
      ...inherited,
      appId: id,
      ...(linearAuth !== undefined ? { linearAuth } : {}),
      ...(appUserId !== undefined ? { appUserId } : {}),
      linearClientId: clientId,
      linearClientSecret: clientSecret,
      linearWebhookSecret: webhookSecret,
      oauthRedirectUri,
      runtime: target.kind,
      ...(kbPath !== undefined ? { kbPath } : {}),
      ...(agentOutputPath !== undefined ? { agentOutputPath } : {}),
      sessionStorePath,
      bridgeStateStorePath,
      oauthTokenStorePath,
      delegationStorePath: path.join(stateDir, "delegations.json"),
    };
    return { id, target, ...(appUserId !== undefined ? { appUserId } : {}), config };
  }

  return { apps };
}

function optionalAbsolutePath(value: unknown, where: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const resolved = requireString(value, where);
  if (!path.isAbsolute(resolved)) {
    throw new Error(`Invalid ${where}: expected an absolute path`);
  }
  return resolved;
}

/**
 * Resolve `<key>File` (a path, never world-readable) or `<key>Env` (an
 * environment variable name). Error messages name the reference, never the
 * value.
 */
function resolveSecret(
  record: Record<string, unknown>,
  key: string,
  where: string,
  env: NodeJS.ProcessEnv,
): string {
  const fileRef = record[`${key}File`];
  const envRef = record[`${key}Env`];
  if ((fileRef === undefined) === (envRef === undefined)) {
    throw new Error(`Invalid ${where}: set exactly one of ${key}File or ${key}Env`);
  }
  if (fileRef !== undefined) {
    const file = requireString(fileRef, `${where}.${key}File`);
    let secret: string;
    try {
      const mode = statSync(file).mode;
      if ((mode & 0o004) !== 0) {
        throw new Error(`Invalid ${where}.${key}File: must not be world-readable`);
      }
      // Group read may come from an ACL grant (the mask); write never may.
      if ((mode & 0o022) !== 0) {
        throw new Error(`Invalid ${where}.${key}File: must not be group- or world-writable`);
      }
      secret = readFileSync(file, "utf8").trim();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid ")) {
        throw error;
      }
      throw new Error(`Invalid ${where}.${key}File: could not be read`);
    }
    if (secret === "") {
      throw new Error(`Invalid ${where}.${key}File: file is empty`);
    }
    return secret;
  }
  const name = requireString(envRef, `${where}.${key}Env`);
  const secret = env[name]?.trim();
  if (secret === undefined || secret === "") {
    throw new Error(`Invalid ${where}.${key}Env: environment variable ${name} is not set`);
  }
  return secret;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${where}: expected a non-empty string`);
  }
  return value;
}

function requireUuid(value: unknown, where: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`Invalid ${where}: expected a UUID`);
  }
  return value;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
