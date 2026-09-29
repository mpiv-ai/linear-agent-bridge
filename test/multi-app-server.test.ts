import { createHmac, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, type AppServerDeps } from "../src/server.js";
import type { Config } from "../src/config.js";
import { LinearAgentClient, type FetchFn } from "../src/linear/client.js";
import { LinearOAuthTokenManager } from "../src/linear/oauth.js";
import { JsonSessionStore } from "../src/sessions/store.js";
import {
  JsonBridgeStateStore,
  type JsonBridgeStateStoreOptions,
} from "../src/state/store.js";
import { createIngressRecoveryKeyring } from "../src/state/recovery-envelope.js";
import { SessionLanes } from "../src/queue.js";
import { JsonDelegationStore, delegationKey } from "../src/delegation-store.js";
import type {
  AgentActivityContent,
  AgentRuntime,
  RuntimeEvent,
  SessionRequest,
} from "../src/types.js";

const DEFAULT_SECRET = "whsec_default_app";
const BUILDER_SECRET = "whsec_builder_app";
const BUILDER_APP_USER = "074ec80c-3be0-4425-aec6-3581c0808569";
const DEFAULT_APP_USER = "7cf4a7e7-e171-481b-811a-8dd8183efc49";

/** What Linear stamps on each app's AgentSessionEvent payloads. */
const APP_BINDING: Record<string, { oauthClientId: string; appUserId?: string }> = {
  [DEFAULT_SECRET]: { oauthClientId: "default-client" },
  [BUILDER_SECRET]: { oauthClientId: "builder-client", appUserId: BUILDER_APP_USER },
};
const RECOVERY_KEY = "A".repeat(43);

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    linearClientId: "default-client",
    linearClientSecret: "default-client-secret",
    linearWebhookSecret: DEFAULT_SECRET,
    port: 0,
    oauthRedirectUri: "http://localhost:3979/oauth/callback",
    runtime: "claude",
    kbPath: "/tmp/kb-unused",
    sessionStorePath: "unused",
    bridgeStateStorePath: "unused",
    oauthTokenStorePath: "unused",
    runInactivityTimeoutMs: 300000,
    progressNoticeIntervalMs: 1,
    ingressRecoveryKey: RECOVERY_KEY,
    ingressRecoveryPreviousKeys: [],
    reconcileIntervalMs: 60000,
    reconcileLookbackMs: 86400000,
    reconcileMaxSessions: 250,
    agentSessionAckGraceMs: 120000,
    autonomousGoalMaxSteps: 8,
    ...overrides,
  };
}

interface ActivityCall {
  agentSessionId: string;
  content: AgentActivityContent;
  ephemeral?: boolean;
  id?: string;
}

interface WorkspaceIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  updatedAt: string;
  delegateId?: string;
  sessions: Array<{ id: string; createdAt: string; appUserId: string }>;
  /** Delegate changes, as Linear's IssueHistory records them. */
  history: Array<{ id: string; createdAt: string; toDelegateId: string }>;
}

/**
 * The slice of a Linear workspace that delegation touches: issues with
 * delegates and Agent Sessions. The acting app is the one whose token made
 * the request.
 */
class FakeWorkspace {
  readonly issues = new Map<string, WorkspaceIssue>();
  readonly sessionCreates: Array<{ issueId: string; appUserId: string }> = [];
  /** Fail this many upcoming history reads with a 503. */
  failHistory = 0;
  readonly tokens = new Map<string, string>();

  /**
   * Add an issue. A `delegateId` without explicit history gets one history
   * entry at `delegatedAt` (default: `updatedAt`).
   */
  addIssue(
    issue: Omit<WorkspaceIssue, "sessions" | "history"> & {
      sessions?: WorkspaceIssue["sessions"];
      history?: WorkspaceIssue["history"];
      delegatedAt?: string;
    },
  ): WorkspaceIssue {
    const { delegatedAt, ...rest } = issue;
    const stored: WorkspaceIssue = {
      sessions: [],
      history:
        issue.history ??
        (issue.delegateId === undefined
          ? []
          : [{ id: `history-${randomUUID()}`, createdAt: delegatedAt ?? issue.updatedAt, toDelegateId: issue.delegateId }]),
      ...rest,
    };
    this.issues.set(issue.id, stored);
    return stored;
  }

  /** Delegate the issue again, as a human would in the UI. */
  redelegate(issueId: string, appUserId: string, at: string): void {
    const issue = this.issues.get(issueId)!;
    issue.delegateId = appUserId;
    issue.updatedAt = at;
    issue.history.push({ id: `history-${randomUUID()}`, createdAt: at, toDelegateId: appUserId });
  }

  private find(idOrIdentifier: string): WorkspaceIssue | undefined {
    return (
      this.issues.get(idOrIdentifier) ??
      [...this.issues.values()].find((issue) => issue.identifier === idOrIdentifier)
    );
  }

  private view(issue: WorkspaceIssue) {
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      updatedAt: issue.updatedAt,
      delegate: issue.delegateId === undefined ? null : { id: issue.delegateId },
      agentSessions: {
        nodes: issue.sessions.map((session) => ({
          id: session.id,
          createdAt: session.createdAt,
          appUser: { id: session.appUserId },
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  }

  /** Answer a delegation-related query, or undefined if it is not one. */
  answer(query: string, variables: Record<string, unknown>, actor: string): Response | undefined {
    if (query.includes("query DelegatedIssues")) {
      const nodes = [...this.issues.values()]
        .filter((issue) => issue.delegateId === variables.appUserId)
        .map((issue) => this.view(issue));
      return Response.json({
        data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    }
    if (query.includes("query DelegationHistory")) {
      if (this.failHistory > 0) {
        this.failHistory -= 1;
        return new Response("unavailable", { status: 503 });
      }
      const issue = this.find(String(variables.id))!;
      return Response.json({
        data: {
          issue: {
            history: {
              nodes: issue.history.map((entry) => ({
                id: entry.id,
                createdAt: entry.createdAt,
                toDelegate: { id: entry.toDelegateId },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    if (query.includes("query DelegationIssue")) {
      const issue = this.find(String(variables.id));
      return issue === undefined
        ? Response.json({ errors: [{ message: "not found" }] })
        : Response.json({ data: { issue: this.view(issue) } });
    }
    if (query.includes("mutation AgentSessionCreateOnIssue")) {
      const issue = this.find(String(variables.issueId))!;
      const session = { id: `session-${randomUUID()}`, createdAt: new Date().toISOString(), appUserId: actor };
      issue.sessions.push(session);
      this.sessionCreates.push({ issueId: issue.id, appUserId: actor });
      return Response.json({ data: { agentSessionCreateOnIssue: { success: true, agentSession: { id: session.id } } } });
    }
    return undefined;
  }

  /** A Linear endpoint that tells apps apart by bearer token. */
  readonly fetch: FetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    const actor = this.tokens.get(token);
    if (actor === undefined) {
      return new Response("unauthorized", { status: 401 });
    }
    const parsed = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    return this.answer(parsed.query, parsed.variables, actor) ?? Response.json({ errors: [{ message: "unhandled" }] });
  }) as FetchFn;
}

/** Fake Linear GraphQL endpoint for one app. */
function fakeLinear(
  calls: ActivityCall[],
  appUserId: string,
  workspace?: FakeWorkspace,
  viewerFailures?: { remaining: number },
): FetchFn {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const parsed = JSON.parse(init?.body as string) as {
      query: string;
      variables: Record<string, unknown> & {
        sessionId?: string;
        input?: {
          id?: string;
          agentSessionId: string;
          content: AgentActivityContent;
          ephemeral?: boolean;
        };
      };
    };
    if (parsed.query.includes("ReconciliationAgentSessionActivities")) {
      return Response.json({
        data: {
          agentSession: {
            id: parsed.variables.sessionId,
            createdAt: "2020-01-01T00:00:00.000Z",
            appUser: { id: appUserId },
            activities: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      });
    }
    if (parsed.query.includes("query BridgeViewer")) {
      if (viewerFailures !== undefined && viewerFailures.remaining > 0) {
        viewerFailures.remaining -= 1;
        return new Response("upstream unavailable", { status: 503 });
      }
      return Response.json({ data: { viewer: { id: appUserId } } });
    }
    const delegation = workspace?.answer(parsed.query, parsed.variables, appUserId);
    if (delegation !== undefined) {
      return delegation;
    }
    if (parsed.query.includes("ReconciliationAgentSessions")) {
      return Response.json({
        data: {
          viewer: { id: appUserId },
          agentSessions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      });
    }
    const input = parsed.variables.input!;
    calls.push({
      agentSessionId: input.agentSessionId,
      content: input.content,
      ...(input.ephemeral !== undefined ? { ephemeral: input.ephemeral } : {}),
      ...(input.id !== undefined ? { id: input.id } : {}),
    });
    return Response.json({ data: { agentActivityCreate: { success: true } } });
  }) as FetchFn;
}

class RecordingRuntime implements AgentRuntime {
  readonly requests: SessionRequest[] = [];

  constructor(
    readonly name = "fake",
    private readonly answer = "default app answered",
  ) {}

  async *runSession(request: SessionRequest): AsyncIterable<RuntimeEvent> {
    this.requests.push(request);
    yield { kind: "session-started", runtimeSessionId: `runtime-${request.linearSessionId}` };
    yield { kind: "activity", activity: { type: "response", body: this.answer } };
    yield { kind: "done" };
  }

  sessionIds(): string[] {
    return this.requests.map((request) => request.linearSessionId);
  }
}

interface AppHarness {
  deps: AppServerDeps;
  calls: ActivityCall[];
  store: JsonSessionStore;
  bridgeState: JsonBridgeStateStore;
  tokenStorePath: string;
}

interface Harness {
  port: number;
  dir: string;
  defaultApp: AppHarness & { runtime: RecordingRuntime };
  builder: AppHarness & { runtime: RecordingRuntime };
  tokenFetch: ReturnType<typeof vi.fn>;
  authorizationUrls: string[];
  close: () => Promise<void>;
}

async function buildApp(
  dir: string,
  name: string,
  config: Config,
  runtime: AgentRuntime,
  appUserId: string,
  tokenFetch: FetchFn,
  bridgeStateOptions: JsonBridgeStateStoreOptions = {},
  workspace?: FakeWorkspace,
  viewerFailures?: { remaining: number },
): Promise<AppHarness> {
  const calls: ActivityCall[] = [];
  const appDir = path.join(dir, name);
  await fs.mkdir(appDir, { recursive: true });
  const tokenStorePath = path.join(appDir, "oauth-tokens.json");
  const store = new JsonSessionStore(path.join(appDir, "sessions.json"));
  const bridgeState = new JsonBridgeStateStore(path.join(appDir, "bridge-state.json"), {
    ...bridgeStateOptions,
    recoveryKeyring: createIngressRecoveryKeyring(RECOVERY_KEY),
  });
  const oauth = new LinearOAuthTokenManager({
    clientId: config.linearClientId,
    clientSecret: config.linearClientSecret,
    storePath: tokenStorePath,
    fetchFn: tokenFetch,
  });
  return {
    deps: {
      config,
      runtime,
      linear: new LinearAgentClient(
        `${name}-access-token`,
        fakeLinear(calls, appUserId, workspace, viewerFailures),
      ),
      oauth,
      store,
      bridgeState,
      queue: new SessionLanes(),
    },
    calls,
    store,
    bridgeState,
    tokenStorePath,
  };
}

async function startHarness(
  options: {
    prepareBuilder?: (builderDir: string) => Promise<void>;
    builderConfig?: Partial<Config>;
    workspace?: FakeWorkspace;
    /** Give the builder app a delegation store (client-credentials apps). */
    builderDelegations?: boolean;
    prepareDelegations?: (store: JsonDelegationStore) => Promise<void>;
    /** Stamp the builder's watchingSince this long ago (default: at startup). */
    builderWatchingSinceAgoMs?: number;
    builderViewerFailures?: { remaining: number };
  } = {},
): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "multi-app-test-"));
  const tokenFetch = vi.fn(async () =>
    Response.json({
      access_token: "installed-access",
      refresh_token: "installed-refresh",
      expires_in: 86400,
      token_type: "Bearer",
      scope: "read write app:assignable app:mentionable",
    }),
  );
  await fs.mkdir(path.join(dir, "builder"), { recursive: true });
  if (options.builderWatchingSinceAgoMs !== undefined) {
    const ago = options.builderWatchingSinceAgoMs;
    await new JsonBridgeStateStore(path.join(dir, "builder", "bridge-state.json"), {
      ownerId: "watching-earlier",
      now: () => Date.now() - ago,
    }).ensureWatchingSince();
  }
  await options.prepareBuilder?.(path.join(dir, "builder"));

  const defaultRuntime = new RecordingRuntime();
  const builderRuntime = new RecordingRuntime("builder-fake", "builder answered");
  const defaultApp = await buildApp(
    dir,
    "default",
    buildConfig(),
    defaultRuntime,
    DEFAULT_APP_USER,
    tokenFetch as unknown as FetchFn,
    {},
    options.workspace,
  );
  const builder = await buildApp(
    dir,
    "builder",
    buildConfig({
      appId: "builder",
      linearClientId: "builder-client",
      linearClientSecret: "builder-client-secret",
      linearWebhookSecret: BUILDER_SECRET,
      appUserId: BUILDER_APP_USER,
      runtime: "codex",
      ...options.builderConfig,
    }),
    builderRuntime,
    BUILDER_APP_USER,
    tokenFetch as unknown as FetchFn,
    {},
    options.workspace,
    options.builderViewerFailures,
  );

  if (options.builderDelegations === true) {
    const delegations = new JsonDelegationStore(path.join(dir, "builder", "delegations.json"));
    await options.prepareDelegations?.(delegations);
    builder.deps.delegations = delegations;
  }
  const authorizationUrls: string[] = [];
  let resolvePort!: (port: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const server = startServer({
    ...defaultApp.deps,
    additionalApps: [builder.deps],
    tokenFetch: tokenFetch as unknown as FetchFn,
    onListening: (port) => resolvePort(port),
    onOAuthAuthorizationUrl: (url) => authorizationUrls.push(url),
  });
  try {
    await server.ready;
    await server.additionalAppsReady;
  } catch (error) {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    throw error;
  }
  const port = await listening;
  return {
    port,
    dir,
    defaultApp: { ...defaultApp, runtime: defaultRuntime },
    builder: { ...builder, runtime: builderRuntime },
    tokenFetch,
    authorizationUrls,
    close: async () => {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
}

let active: Harness | undefined;

afterEach(async () => {
  await active?.close();
  active = undefined;
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createdPayload(sessionId: string, deliveryId = randomUUID()) {
  return {
    deliveryId,
    payload: {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "webhook-config-id",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: sessionId,
        issue: { id: `issue-${sessionId}`, identifier: "ENG-77", title: "Reconcile ledger" },
      },
      promptContext: "<issue identifier=\"ENG-77\"><title>Reconcile ledger</title></issue>",
    },
  };
}

function promptedPayload(
  sessionId: string,
  activityId: string,
  body: string,
  signal?: string,
) {
  return {
    deliveryId: randomUUID(),
    payload: {
      type: "AgentSessionEvent",
      action: "prompted",
      webhookId: "webhook-config-id",
      webhookTimestamp: Date.now(),
      agentSession: { id: sessionId },
      agentActivity: {
        id: activityId,
        createdAt: new Date().toISOString(),
        content: { type: "prompt", body, ...(signal !== undefined ? { signal } : {}) },
        ...(signal !== undefined ? { signal } : {}),
      },
    },
  };
}

async function post(
  harness: Harness,
  event: { deliveryId: string; payload: Record<string, unknown> },
  secret: string,
  binding: Record<string, unknown> | "none" = APP_BINDING[secret] ?? {},
): Promise<Response> {
  const body = JSON.stringify(
    binding === "none" ? event.payload : { ...event.payload, ...binding },
  );
  return await fetch(`http://127.0.0.1:${harness.port}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
      "linear-delivery": event.deliveryId,
      connection: "close",
    },
    body,
  });
}

describe("multi-app ingress", () => {
  it("routes a delivery to the app whose signing secret verifies it and runs that app's own runtime", async () => {
    active = await startHarness();
    const harness = active;
    const event = createdPayload("builder-session-1");

    const response = await post(harness, event, BUILDER_SECRET);
    expect(response.status).toBe(200);

    await waitFor(() =>
      harness.builder.calls.some((call) => call.content.type === "response"),
    );
    expect(harness.builder.runtime.sessionIds()).toEqual(["builder-session-1"]);
    expect(harness.builder.calls.map((call) => call.content)).toContainEqual({
      type: "response",
      body: "builder answered",
    });
    expect(harness.defaultApp.calls).toEqual([]);
    expect(harness.defaultApp.runtime.requests).toEqual([]);
    await waitFor(
      async () =>
        (await harness.builder.bridgeState.getReceipt(event.deliveryId))?.status ===
        "completed",
    );
    await expect(harness.defaultApp.bridgeState.getReceipt(event.deliveryId)).resolves.toBeUndefined();
    await expect(harness.builder.store.get("builder-session-1")).resolves.toMatchObject({
      runtime: "builder-fake",
      runtimeSessionId: "runtime-builder-session-1",
      issueIdentifier: "ENG-77",
    });
  });

  it("keeps the env-configured default app on its own runtime and state", async () => {
    active = await startHarness();
    const harness = active;
    const event = createdPayload("default-session-1");

    expect((await post(harness, event, DEFAULT_SECRET)).status).toBe(200);
    await waitFor(() =>
      harness.defaultApp.calls.some((call) => call.content.type === "response"),
    );

    expect(harness.defaultApp.runtime.requests).toEqual([
      {
        linearSessionId: "default-session-1",
        prompt: event.payload.promptContext,
        abortController: expect.any(AbortController),
      },
    ]);
    expect(harness.builder.calls).toEqual([]);
    expect(harness.builder.runtime.requests).toEqual([]);
    await expect(harness.builder.bridgeState.getReceipt(event.deliveryId)).resolves.toBeUndefined();
  });

  it("rejects a delivery no configured app signed, before any durable write", async () => {
    active = await startHarness();
    const harness = active;
    const event = createdPayload("forged-session");

    const response = await post(harness, event, "whsec_unknown_app");
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("invalid signature");

    const unsigned = await fetch(`http://127.0.0.1:${harness.port}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", connection: "close" },
      body: JSON.stringify(event.payload),
    });
    expect(unsigned.status).toBe(401);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(harness.defaultApp.bridgeState.getReceipt(event.deliveryId)).resolves.toBeUndefined();
    await expect(harness.builder.bridgeState.getReceipt(event.deliveryId)).resolves.toBeUndefined();
    expect(harness.builder.runtime.requests).toEqual([]);
    expect(harness.defaultApp.runtime.requests).toEqual([]);
  });

  it("rejects a verified delivery whose payload names another app, or omits the app", async () => {
    active = await startHarness();
    const harness = active;
    const cases: Array<Record<string, unknown> | "none"> = [
      { oauthClientId: "default-client", appUserId: BUILDER_APP_USER },
      { oauthClientId: "builder-client", appUserId: "c350d834-950d-4098-b590-38ca3f40d333" },
      "none",
    ];
    for (const binding of cases) {
      const event = createdPayload(`mismatch-${randomUUID()}`);
      const response = await post(harness, event, BUILDER_SECRET, binding);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("app binding mismatch");
      await expect(harness.builder.bridgeState.getReceipt(event.deliveryId)).resolves.toBeUndefined();
    }
    // The default app keeps accepting legacy payloads without the fields,
    // and still rejects one that names a different OAuth client.
    const legacy = await post(harness, createdPayload("legacy-default"), DEFAULT_SECRET, "none");
    expect(legacy.status).toBe(200);
    const foreign = await post(harness, createdPayload("foreign-default"), DEFAULT_SECRET, {
      oauthClientId: "builder-client",
    });
    expect(foreign.status).toBe(401);
    expect(harness.builder.runtime.requests).toEqual([]);
  });

  it("completes OAuth for the app that issued the state, with that app's client", async () => {
    active = await startHarness();
    const harness = active;
    expect(harness.authorizationUrls).toHaveLength(2);
    const builderUrl = new URL(
      harness.authorizationUrls.find(
        (url) => new URL(url).searchParams.get("client_id") === "builder-client",
      )!,
    );
    expect(builderUrl.searchParams.get("scope")).toBe(
      "read,write,app:assignable,app:mentionable",
    );
    expect(builderUrl.searchParams.get("actor")).toBe("app");

    const callback = await fetch(
      `http://127.0.0.1:${harness.port}/oauth/callback?state=${builderUrl.searchParams.get("state")}&code=builder-code`,
      { headers: { connection: "close" } },
    );
    expect(callback.status).toBe(200);
    await callback.text();
    const [, exchangeInit] = harness.tokenFetch.mock.calls[0] as unknown as [
      unknown,
      RequestInit,
    ];
    const exchange = new URLSearchParams(String(exchangeInit.body));
    expect(exchange.get("client_id")).toBe("builder-client");
    expect(exchange.get("client_secret")).toBe("builder-client-secret");
    await expect(fs.readFile(harness.builder.tokenStorePath, "utf8")).resolves.toContain(
      "installed-refresh",
    );
    await expect(fs.access(harness.defaultApp.tokenStorePath)).rejects.toThrow();

    // The state is single-use.
    const replay = await fetch(
      `http://127.0.0.1:${harness.port}/oauth/callback?state=${builderUrl.searchParams.get("state")}&code=builder-code`,
      { headers: { connection: "close" } },
    );
    expect(replay.status).toBe(400);
    await replay.text();
  });

  it("reports healthy only once every app is ready", async () => {
    active = await startHarness();
    const response = await fetch(`http://127.0.0.1:${active.port}/healthz`, {
      headers: { connection: "close" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

/** A created event a prior process claimed, dispatched, and completed. */
async function completedPriorCreated(builderDir: string, sessionId: string): Promise<void> {
  const prior = priorProcessState(builderDir);
  const identity = {
    webhookId: `delivery-${sessionId}`,
    executionId: `created:${sessionId}`,
    linearSessionId: sessionId,
    action: "created" as const,
  };
  await prior.claimEvent(identity, {
    action: "created",
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    prompt: "earlier work",
  });
  await prior.markDispatchStarted(identity.webhookId);
  await prior.completeEvent(identity.webhookId);
}

function priorProcessState(builderDir: string): JsonBridgeStateStore {
  return new JsonBridgeStateStore(path.join(builderDir, "bridge-state.json"), {
    ownerId: "prior-process",
    recoveryKeyring: createIngressRecoveryKeyring(RECOVERY_KEY),
  });
}

describe("app isolation", () => {
  it("keeps the default app serving when an additional app cannot start", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "multi-app-isolation-"));
    try {
      const defaultCalls: ActivityCall[] = [];
      const brokenStatePath = path.join(dir, "broken-state");
      await fs.mkdir(brokenStatePath);
      const appDeps = (
        config: Config,
        calls: ActivityCall[],
        statePath: string,
        runtime: AgentRuntime,
      ): AppServerDeps => ({
        config,
        runtime,
        linear: new LinearAgentClient("token", fakeLinear(calls, "app-user")),
        oauth: new LinearOAuthTokenManager({
          clientId: config.linearClientId,
          clientSecret: config.linearClientSecret,
          initialAccessToken: "token",
          storePath: path.join(dir, `${config.linearClientId}-tokens.json`),
        }),
        store: new JsonSessionStore(path.join(dir, `${config.linearClientId}-sessions.json`)),
        bridgeState: new JsonBridgeStateStore(statePath, {
          recoveryKeyring: createIngressRecoveryKeyring(RECOVERY_KEY),
        }),
        queue: new SessionLanes(),
      });
      const defaultRuntime = new RecordingRuntime();
      let resolvePort!: (port: number) => void;
      const listening = new Promise<number>((resolve) => {
        resolvePort = resolve;
      });
      const errors: string[] = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
        errors.push(String(message));
      });
      const server = startServer({
        ...appDeps(buildConfig(), defaultCalls, path.join(dir, "default-state.json"), defaultRuntime),
        additionalApps: [
          appDeps(
            buildConfig({
              appId: "builder",
              linearClientId: "builder-client",
              linearWebhookSecret: BUILDER_SECRET,
            }),
            [],
            brokenStatePath,
            new RecordingRuntime(),
          ),
        ],
        onListening: (port) => resolvePort(port),
      });
      try {
        await server.ready;
        await expect(server.additionalAppsReady).rejects.toThrow();
        const port = await listening;
        expect(errors.some((line) => line.includes("app unavailable: app=builder"))).toBe(true);

        const health = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { connection: "close" } });
        expect(health.status).toBe(200);
        expect(await health.text()).toBe("ok; unready apps: builder");

        const harnessLike = { port } as Harness;
        const blocked = await post(harnessLike, createdPayload("builder-blocked"), BUILDER_SECRET);
        expect(blocked.status).toBe(503);
        await blocked.text();
        const served = await post(harnessLike, createdPayload("default-still-served"), DEFAULT_SECRET);
        expect(served.status).toBe(200);
        await waitFor(() => defaultCalls.some((call) => call.content.type === "response"));
      } finally {
        errorSpy.mockRestore();
        await server.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });
});


describe("client-credentials apps", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const fallbackHarness = (workspace: FakeWorkspace, prepareDelegations?: (store: JsonDelegationStore) => Promise<void>) =>
    startHarness({
      builderConfig: { linearAuth: "client_credentials" },
      builderDelegations: true,
      builderWatchingSinceAgoMs: 60 * 60 * 1000,
      workspace,
      ...(prepareDelegations !== undefined ? { prepareDelegations } : {}),
    });

  it("never prints an authorization URL for a client-credentials app", async () => {
    active = await startHarness({
      builderConfig: { linearAuth: "client_credentials" },
      workspace: new FakeWorkspace(),
    });
    expect(
      active.authorizationUrls.map((url) => new URL(url).searchParams.get("client_id")),
    ).toEqual(["default-client"]);
  });

  it("learns the app user from viewer { id } and then enforces it on every delivery", async () => {
    active = await startHarness({
      builderConfig: { linearAuth: "client_credentials", appUserId: undefined },
      workspace: new FakeWorkspace(),
    });
    const harness = active;
    const wrongUser = await post(harness, createdPayload("viewer-bound"), BUILDER_SECRET, {
      oauthClientId: "builder-client",
      appUserId: DEFAULT_APP_USER,
    });
    expect(wrongUser.status).toBe(401);
    expect((await post(harness, createdPayload("viewer-ok"), BUILDER_SECRET)).status).toBe(200);
    await waitFor(() => harness.builder.runtime.requests.length === 1);
  });

  it("keeps a client-credentials app down when its token's viewer contradicts the configured id", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        startHarness({
          builderConfig: {
            linearAuth: "client_credentials",
            appUserId: "c350d834-950d-4098-b590-38ca3f40d333",
          },
          workspace: new FakeWorkspace(),
        }),
      ).rejects.toThrow("does not match the app token's viewer");
    } finally {
      spy.mockRestore();
    }
  });

  it("opens and dispatches a session when a delegation never produced one", async () => {
    const workspace = new FakeWorkspace();
    workspace.addIssue({
      id: "issue-missed",
      identifier: "ENG-900",
      title: "Reconcile the vendor ledger",
      description: "Delegated to Builder with no session.",
      updatedAt: minutesAgo(10),
      delegateId: BUILDER_APP_USER,
    });
    // Too recent to judge: Linear's webhook may still be on its way.
    workspace.addIssue({
      id: "issue-young",
      identifier: "ENG-901",
      title: "Just delegated",
      description: "",
      updatedAt: new Date().toISOString(),
      delegateId: BUILDER_APP_USER,
    });
    active = await fallbackHarness(workspace);
    const harness = active;

    await waitFor(() => harness.builder.runtime.requests.length === 1);
    expect(workspace.sessionCreates).toEqual([
      { issueId: "issue-missed", appUserId: BUILDER_APP_USER },
    ]);
    const opened = workspace.issues.get("issue-missed")!.sessions[0]!.id;
    expect(harness.builder.runtime.sessionIds()).toEqual([opened]);
    expect(harness.builder.runtime.requests[0]!.prompt).toContain(
      '<issue identifier="ENG-900">\n<title>Reconcile the vendor ledger</title>',
    );
    // Linear's own created webhook for the same session is a duplicate.
    const late = { deliveryId: randomUUID(), payload: createdPayload(opened).payload };
    const response = await post(harness, late, BUILDER_SECRET);
    expect(response.headers.get("x-bridge-ingress")).toBe("superseded");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.builder.runtime.requests).toHaveLength(1);
  });

  // Finding 2: work opened by the bridge must survive a crash between
  // agentSessionCreateOnIssue and the durable created claim.
  it("adopts and dispatches a session the bridge opened before crashing, without opening another", async () => {
    const workspace = new FakeWorkspace();
    const delegatedAt = minutesAgo(10);
    const issue = workspace.addIssue({
      id: "issue-crashed",
      identifier: "ENG-903",
      title: "Crash window",
      description: "",
      updatedAt: delegatedAt,
      delegateId: BUILDER_APP_USER,
    });
    // The prior process recorded its intent, opened this session a moment
    // ago (younger than the ack grace), and died before claiming it.
    const orphan = { id: "session-orphaned", createdAt: new Date().toISOString(), appUserId: BUILDER_APP_USER };
    issue.sessions.push(orphan);
    active = await fallbackHarness(workspace, async (store) => {
      await store.recordIntent(delegationKey(issue.id, issue.history[0]!.id), {
        issueId: issue.id,
        delegationId: issue.history[0]!.id,
        delegatedAt,
      });
    });
    const harness = active;
    await waitFor(() => harness.builder.runtime.requests.length === 1);
    expect(workspace.sessionCreates).toEqual([]);
    expect(harness.builder.runtime.sessionIds()).toEqual(["session-orphaned"]);
    await expect(harness.builder.bridgeState.getClaim("created:session-orphaned")).resolves.toBeDefined();
  });

  // Finding 2 (second half): a claimed session for the current delegation
  // is done; only an unclaimed one is work.
  it("leaves a delegation alone once one of its sessions has a created claim", async () => {
    const workspace = new FakeWorkspace();
    const issue = workspace.addIssue({
      id: "issue-served",
      identifier: "ENG-904",
      title: "Normal delegation",
      description: "",
      updatedAt: minutesAgo(10),
      delegateId: BUILDER_APP_USER,
      sessions: [{ id: "served-session", createdAt: minutesAgo(9), appUserId: BUILDER_APP_USER }],
    });
    active = await startHarness({
      builderConfig: { linearAuth: "client_credentials" },
      builderDelegations: true,
      workspace,
      prepareBuilder: async (builderDir) => {
        await completedPriorCreated(builderDir, "served-session");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(workspace.sessionCreates).toEqual([]);
    expect(active.builder.runtime.requests).toEqual([]);
    expect(issue.sessions).toHaveLength(1);
  });

  // Finding 7c: a historical session must not suppress a new delegation.
  it("treats a repeat delegation as new work even when an older session exists", async () => {
    const workspace = new FakeWorkspace();
    const issue = workspace.addIssue({
      id: "issue-again",
      identifier: "ENG-905",
      title: "Delegated twice",
      description: "",
      updatedAt: minutesAgo(600),
      delegateId: BUILDER_APP_USER,
      sessions: [{ id: "old-session", createdAt: minutesAgo(590), appUserId: BUILDER_APP_USER }],
    });
    workspace.redelegate(issue.id, BUILDER_APP_USER, minutesAgo(10));
    active = await startHarness({
      builderConfig: { linearAuth: "client_credentials" },
      builderDelegations: true,
      builderWatchingSinceAgoMs: 60 * 60 * 1000,
      workspace,
      prepareBuilder: async (builderDir) => {
        await completedPriorCreated(builderDir, "old-session");
      },
    });
    const harness = active;
    await waitFor(() => harness.builder.runtime.requests.length === 1);
    expect(workspace.sessionCreates).toEqual([{ issueId: issue.id, appUserId: BUILDER_APP_USER }]);
  });

});

describe("review round 2 regressions", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
  // Round 2, finding 1: history never re-dispatches.
  it("leaves a delegation made before the bridge was watching alone, even with no claim", async () => {
    const workspace = new FakeWorkspace();
    workspace.addIssue({
      id: "issue-before-watching",
      identifier: "ENG-960",
      title: "Delegated before cutover",
      description: "",
      updatedAt: minutesAgo(1),
      delegateId: BUILDER_APP_USER,
      delegatedAt: minutesAgo(30),
    });
    active = await startHarness({
      builderConfig: { linearAuth: "client_credentials" },
      builderDelegations: true,
      builderWatchingSinceAgoMs: 10 * 60 * 1000,
      workspace,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(workspace.sessionCreates).toEqual([]);
    expect(active.builder.runtime.requests).toEqual([]);
  });

  it("leaves a delegation older than the lookback alone after its claim was pruned", async () => {
    const workspace = new FakeWorkspace();
    workspace.addIssue({
      id: "issue-ten-days",
      identifier: "ENG-961",
      title: "Delegated ten days ago",
      description: "",
      // A human comment brings it back into the updatedAt window.
      updatedAt: minutesAgo(3),
      delegateId: BUILDER_APP_USER,
      delegatedAt: minutesAgo(10 * 24 * 60),
      sessions: [{ id: "long-done", createdAt: minutesAgo(10 * 24 * 60 - 1), appUserId: BUILDER_APP_USER }],
    });
    active = await startHarness({
      builderConfig: { linearAuth: "client_credentials" },
      builderDelegations: true,
      builderWatchingSinceAgoMs: 30 * 24 * 60 * 60 * 1000,
      workspace,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(workspace.sessionCreates).toEqual([]);
    expect(active.builder.runtime.requests).toEqual([]);
    await expect(active.builder.bridgeState.getClaim("created:long-done")).resolves.toBeUndefined();
  });

  // Round 2, finding 3: a boot-time outage is retried, not permanent.
  it("retries the app user lookup after a transient failure and then serves the app", async () => {
    // More failures than the Linear client's own three attempts per call.
    const failures = { remaining: 4 };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      active = await startHarness({
        builderConfig: { linearAuth: "client_credentials", appUserId: undefined },
        builderViewerFailures: failures,
        workspace: new FakeWorkspace(),
      });
    } finally {
      errors.mockRestore();
    }
    const harness = active;
    expect(failures.remaining).toBe(0);
    expect((await post(harness, createdPayload("after-outage"), BUILDER_SECRET)).status).toBe(200);
    await waitFor(() => harness.builder.runtime.requests.length === 1);
  });
});
