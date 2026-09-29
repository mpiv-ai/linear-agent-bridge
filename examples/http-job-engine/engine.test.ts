import { afterEach, describe, expect, it } from "vitest";
import { ScriptedBackend } from "../../conformance/kit.js";
import type { RuntimeEvent, SessionRequest } from "../../src/types.js";
import { HttpJobRuntime } from "./engine.js";
import { startFakeJobServer, type FakeJobServer } from "./fake-server.js";

let server: FakeJobServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function collect(source: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function request(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return { linearSessionId: "s1", prompt: "go", abortController: new AbortController(), ...overrides };
}

describe("HttpJobRuntime", () => {
  it("submits once when the same turnId is delivered twice", async () => {
    const backend = new ScriptedBackend();
    server = await startFakeJobServer(backend);
    const runtime = new HttpJobRuntime({ baseUrl: server.url, pollIntervalMs: 5 });
    backend.enqueue([{ type: "response", text: "hi" }]);

    const first = await collect(runtime.runSession(request({ turnId: "turn-1" })));
    const second = await collect(runtime.runSession(request({ turnId: "turn-1" })));

    expect(backend.turns).toHaveLength(1);
    const started = (events: RuntimeEvent[]) => events.find((e) => e.kind === "session-started");
    expect(started(second)).toEqual(started(first));
  });

  it("sends the token as a bearer header, and is refused without it", async () => {
    const backend = new ScriptedBackend();
    server = await startFakeJobServer(backend, { token: "secret-token" });
    const seen: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return fetch(input, init);
    };
    backend.enqueue([{ type: "response", text: "ok" }]);

    const authed = new HttpJobRuntime({ baseUrl: server.url, token: "secret-token", pollIntervalMs: 5, fetch: recording });
    await collect(authed.runSession(request()));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["Bearer secret-token"]));

    const anonymous = new HttpJobRuntime({ baseUrl: server.url, pollIntervalMs: 5 });
    const failure = collect(anonymous.runSession(request())).catch((error: unknown) => error as Error);
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("reports stopped only for the call that ended live work", async () => {
    const backend = new ScriptedBackend();
    server = await startFakeJobServer(backend);
    const runtime = new HttpJobRuntime({ baseUrl: server.url, pollIntervalMs: 5 });
    backend.enqueue([{ type: "hang" }]);
    const req = request();
    let threadId: string | undefined;
    const turn = (async () => {
      for await (const event of runtime.runSession(req)) {
        if (event.kind === "session-started") {
          threadId = event.runtimeSessionId;
        }
      }
    })();
    while (threadId === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const session = { linearSessionId: "s1", runtimeSessionId: threadId };
    expect(await runtime.stopForClosedIssue(session)).toEqual({ stopped: true });
    expect(await runtime.stopForClosedIssue(session)).toEqual({ stopped: false });
    expect(await runtime.stopForClosedIssue({ linearSessionId: "s1" })).toEqual({ stopped: false });
    await turn; // the job is cancelled, so the watch ends by itself
  });

  it("yields no progress while polls come back empty", async () => {
    const backend = new ScriptedBackend();
    server = await startFakeJobServer(backend);
    const runtime = new HttpJobRuntime({ baseUrl: server.url, pollIntervalMs: 5 });
    backend.enqueue([{ type: "hang" }]);
    const req = request();
    const events: RuntimeEvent[] = [];
    const turn = (async () => {
      for await (const event of runtime.runSession(req)) {
        events.push(event);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 100)); // many empty polls
    req.abortController!.abort();
    await turn;

    expect(events.map((e) => e.kind)).toEqual(["session-started", "watching", "done"]);
    expect(backend.turns[0]?.cancelled).toBe(false);
  });
});
