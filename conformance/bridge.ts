// Runs a real bridge (startServer) around an engine, with Linear replaced
// by an in-memory GraphQL fake. Extracted from test/server.test.ts so the
// conformance suite exercises the same ingress, queue, watchdog, and
// activity paths production uses.

import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../src/config.js";
import { LinearAgentClient, type FetchFn } from "../src/linear/client.js";
import { LinearOAuthTokenManager } from "../src/linear/oauth.js";
import { SessionLanes } from "../src/queue.js";
import { startServer, type ServerDeps } from "../src/server.js";
import { JsonSessionStore } from "../src/sessions/store.js";
import { createIngressRecoveryKeyring } from "../src/state/recovery-envelope.js";
import { JsonBridgeStateStore } from "../src/state/store.js";
import type { AgentActivityContent, AgentRuntime } from "../src/types.js";

const WEBHOOK_SECRET = "conformance-webhook-secret";

/** One agentActivityCreate the bridge sent to Linear. */
export interface PostedActivity {
  id: string | undefined;
  agentSessionId: string;
  content: AgentActivityContent;
  ephemeral: boolean;
}

export interface TestBridge {
  readonly posted: PostedActivity[];
  readonly store: JsonSessionStore;
  /** POST a signed webhook. `deliveryId` defaults to a fresh one. */
  deliver(payload: Record<string, unknown>, deliveryId?: string): Promise<Response>;
  close(): Promise<void>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeLinear(posted: PostedActivity[]): FetchFn {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: Record<string, unknown> & {
        input?: { id?: string; agentSessionId: string; content: AgentActivityContent; ephemeral?: boolean };
        sessionId?: string;
      };
    };
    if (request.query.includes("ReconciliationAgentSessionActivities")) {
      return json({
        data: {
          agentSession: {
            id: request.variables?.sessionId,
            createdAt: "2020-01-01T00:00:00.000Z",
            appUser: { id: "conformance-app-user" },
            activities: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      });
    }
    if (request.query.includes("Reconciliation")) {
      return json({
        data: {
          viewer: { id: "conformance-app-user" },
          agentSessions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      });
    }
    const input = request.variables?.input;
    if (input?.content !== undefined) {
      posted.push({
        id: input.id,
        agentSessionId: input.agentSessionId,
        content: input.content,
        ephemeral: input.ephemeral === true,
      });
      return json({ data: { agentActivityCreate: { success: true } } });
    }
    return json({ data: {} });
  }) as FetchFn;
}

export async function startBridge(
  runtime: AgentRuntime,
  overrides: Partial<Config> = {},
): Promise<TestBridge> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "engine-conformance-"));
  const posted: PostedActivity[] = [];
  const store = new JsonSessionStore(path.join(tmpDir, "sessions.json"));
  const queue = new SessionLanes();
  const config: Config = {
    linearClientId: "conformance-client",
    linearClientSecret: "conformance-client-secret",
    linearWebhookSecret: WEBHOOK_SECRET,
    linearAccessToken: "conformance-token",
    port: 0,
    oauthRedirectUri: "http://localhost:0/oauth/callback",
    runtime: "claude",
    kbPath: tmpDir,
    sessionStorePath: path.join(tmpDir, "sessions.json"),
    bridgeStateStorePath: path.join(tmpDir, "bridge-state.json"),
    oauthTokenStorePath: path.join(tmpDir, "oauth.json"),
    runInactivityTimeoutMs: 300_000,
    progressNoticeIntervalMs: 3_600_000,
    ingressRecoveryKey: "A".repeat(43),
    ingressRecoveryPreviousKeys: [],
    reconcileIntervalMs: 3_600_000,
    reconcileLookbackMs: 86_400_000,
    reconcileMaxSessions: 250,
    agentSessionAckGraceMs: 120_000,
    autonomousGoalMaxSteps: 8,
    shutdownTimeoutMs: 5_000,
    ...overrides,
  };
  let resolvePort!: (port: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const oauth = new LinearOAuthTokenManager({
    clientId: config.linearClientId,
    clientSecret: config.linearClientSecret,
    initialAccessToken: "conformance-token",
    storePath: config.oauthTokenStorePath,
  });
  const deps: ServerDeps = {
    config,
    runtime,
    linear: new LinearAgentClient("conformance-token", fakeLinear(posted)),
    oauth,
    store,
    bridgeState: new JsonBridgeStateStore(config.bridgeStateStorePath, {
      recoveryKeyring: createIngressRecoveryKeyring(config.ingressRecoveryKey, []),
    }),
    queue,
    onListening: (port) => resolvePort(port),
  };
  const server = startServer(deps);
  await server.ready;
  const port = await listening;
  let deliveries = 0;
  return {
    posted,
    store,
    async deliver(payload, deliveryId) {
      const body = JSON.stringify(payload);
      return await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "linear-signature": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"),
          "linear-delivery": deliveryId ?? `conformance-delivery-${++deliveries}-${Date.now()}`,
          connection: "close",
        },
        body,
      });
    },
    async close() {
      await server.close();
      await queue.drain();
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

/** A Linear `created` AgentSessionEvent for a new session. */
export function createdEvent(sessionId: string, prompt: string): Record<string, unknown> {
  return {
    type: "AgentSessionEvent",
    action: "created",
    webhookId: "conformance-webhook",
    webhookTimestamp: Date.now(),
    agentSession: {
      id: sessionId,
      createdAt: new Date().toISOString(),
      issue: { id: `issue-${sessionId}`, identifier: "ENG-1", title: "Conformance" },
    },
    promptContext: prompt,
  };
}

/** A Linear `prompted` AgentSessionEvent; `signal: "stop"` is a stop. */
export function promptedEvent(
  sessionId: string,
  activityId: string,
  body: string,
  signal?: "stop",
): Record<string, unknown> {
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    webhookId: "conformance-webhook",
    webhookTimestamp: Date.now(),
    agentSession: { id: sessionId },
    agentActivity: {
      id: activityId,
      createdAt: new Date().toISOString(),
      content: { type: "prompt", body, ...(signal !== undefined ? { signal } : {}) },
    },
  };
}

/** Poll until `predicate` holds, or fail after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`conformance: timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
