// The engine conformance suite. `runEngineConformance(engine)` registers
// one vitest `describe` block that checks an AgentRuntime against the
// contract in src/types.ts, first directly and then inside a real bridge.
//
// Engines whose work continues outside the bridge process declare
// `stopSession`. For them, aborting a turn only detaches it (shutdown and
// inactivity abort too); only a Linear stop cancels the backend work. For
// every other engine an abort must cancel the backend turn.

import { afterEach, describe, expect, it } from "vitest";
import type { AgentActivityContent, RuntimeEvent, SessionRequest } from "../src/types.js";
import { createdEvent, promptedEvent, startBridge, waitFor, type TestBridge } from "./bridge.js";
import type { EngineDefinition, EngineHarness } from "./kit.js";

/** How long a turn may take to end after it is aborted or force-closed. */
const PROMPT_END_MS = 2000;

interface TurnResult {
  events: RuntimeEvent[];
  error: unknown;
}

function newRequest(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    linearSessionId: "conformance-session",
    prompt: "conformance prompt",
    abortController: new AbortController(),
    turnId: `turn-${Math.random().toString(36).slice(2)}`,
    issueIdentifier: "ENG-1",
    issueId: "issue-conformance",
    ...overrides,
  };
}

/** Run one turn, recording every event except progress. Never rejects. */
async function runTurn(
  harness: EngineHarness,
  request: SessionRequest,
  onEvent?: (event: RuntimeEvent) => void,
): Promise<TurnResult> {
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of harness.runtime.runSession(request)) {
      if (event.kind !== "progress") {
        events.push(event);
        onEvent?.(event);
      }
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error };
  }
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`conformance: ${what} took longer than ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function activities(events: RuntimeEvent[]): AgentActivityContent[] {
  return events.flatMap((event) => (event.kind === "activity" ? [event.activity] : []));
}

function ofType<T extends AgentActivityContent["type"]>(
  list: AgentActivityContent[],
  type: T,
): Array<Extract<AgentActivityContent, { type: T }>> {
  return list.filter((activity): activity is Extract<AgentActivityContent, { type: T }> => activity.type === type);
}

function sessionIdOf(events: RuntimeEvent[]): string | undefined {
  const started = events.find((event) => event.kind === "session-started");
  return started?.kind === "session-started" ? started.runtimeSessionId : undefined;
}

/** Wait until the backend sits at its hang or gate step, mid-turn. */
async function backendWaiting(harness: EngineHarness): Promise<void> {
  await waitFor(() => harness.backend.turns.at(-1)?.waiting === true, "the backend to reach its hang or gate step", PROMPT_END_MS);
}

export function runEngineConformance(engine: EngineDefinition): void {
  describe(`engine conformance: ${engine.name}`, () => {
    let harness: EngineHarness | undefined;
    let bridge: TestBridge | undefined;

    async function setUp(): Promise<EngineHarness> {
      harness = await engine.createHarness();
      return harness;
    }

    afterEach(async () => {
      harness?.backend.release();
      await bridge?.close();
      await harness?.dispose?.();
      bridge = undefined;
      harness = undefined;
    });

    const isExternal = (h: EngineHarness): boolean => h.runtime.stopSession !== undefined;

    describe("runtime contract", () => {
      it("starts a session: reports its id before any activity and ends with done", async () => {
        const h = await setUp();
        h.backend.enqueue([{ type: "response", text: "hello" }]);
        const { events, error } = await runTurn(h, newRequest({ prompt: "say hello" }));

        expect(error).toBeUndefined();
        expect(h.backend.turns).toHaveLength(1);
        expect(h.backend.turns[0]?.resumeSessionId).toBeUndefined();
        expect(h.backend.turns[0]?.prompt).toContain("say hello");
        const startedAt = events.findIndex((event) => event.kind === "session-started");
        const firstActivity = events.findIndex((event) => event.kind === "activity");
        expect(startedAt, "session-started is required").toBeGreaterThanOrEqual(0);
        expect(startedAt).toBeLessThan(firstActivity);
        expect(sessionIdOf(events)).toBe(h.backend.turns[0]?.sessionId);
        expect(events.at(-1)).toEqual({ kind: "done" });
        expect(events.filter((event) => event.kind === "done")).toHaveLength(1);
      });

      it("resumes the session id it reported on the next turn", async () => {
        const h = await setUp();
        h.backend.enqueue([{ type: "response", text: "first" }]);
        h.backend.enqueue([{ type: "response", text: "second" }]);
        const first = await runTurn(h, newRequest());
        const sessionId = sessionIdOf(first.events);
        expect(sessionId).toBeDefined();

        const second = await runTurn(h, newRequest({ prompt: "follow up", resumeSessionId: sessionId, isFollowUp: true }));

        expect(second.error).toBeUndefined();
        expect(h.backend.turns).toHaveLength(2);
        expect(h.backend.turns[1]?.resumeSessionId).toBe(sessionId);
        expect(h.backend.turns[1]?.prompt).toContain("follow up");
        const resumedId = sessionIdOf(second.events);
        if (resumedId !== undefined) {
          expect(resumedId).toBe(sessionId);
        }
        expect(ofType(activities(second.events), "response").map((a) => a.body)).toEqual(["second"]);
      });

      it("yields interim thoughts, exactly one response, then done", async () => {
        const h = await setUp();
        h.backend.enqueue([
          { type: "thought", text: "looking around" },
          { type: "response", text: "the answer" },
        ]);
        const { events, error } = await runTurn(h, newRequest());

        expect(error).toBeUndefined();
        const list = activities(events);
        expect(ofType(list, "thought").map((a) => a.body)).toContain("looking around");
        expect(ofType(list, "response").map((a) => a.body)).toEqual(["the answer"]);
        expect(ofType(list, "error")).toEqual([]);
        expect(events.at(-1)).toEqual({ kind: "done" });
      });

      it("closes every tool action card it opens with the same action and parameter", async () => {
        const h = await setUp();
        h.backend.enqueue([
          { type: "tool", name: "read_file", input: { path: "notes.md" }, output: "contents" },
          { type: "response", text: "read it" },
        ]);
        const { events, error } = await runTurn(h, newRequest());

        expect(error).toBeUndefined();
        const actions = ofType(activities(events), "action");
        const closed = actions.filter((a) => a.result !== undefined);
        expect(closed.length, "the tool call must produce a closed action card").toBeGreaterThan(0);
        for (const [index, open] of actions.entries()) {
          if (open.result !== undefined) {
            continue;
          }
          const closer = actions
            .slice(index + 1)
            .find((a) => a.result !== undefined && a.action === open.action && a.parameter === open.parameter);
          expect(closer, `open card "${open.action}" is never closed`).toBeDefined();
        }
      });

      it("fails visibly when the backend throws mid-stream, without a response", async () => {
        const h = await setUp();
        h.backend.enqueue([
          { type: "thought", text: "about to fail" },
          { type: "throw", message: "backend exploded" },
        ]);
        const { events, error } = await runTurn(h, newRequest());

        const list = activities(events);
        expect(
          error !== undefined || ofType(list, "error").length > 0,
          "a failure must throw from runSession or yield an error activity",
        ).toBe(true);
        expect(ofType(list, "response")).toEqual([]);
      });

      it("ends promptly when the turn is aborted mid-stream, with no later response", async () => {
        const h = await setUp();
        h.backend.enqueue([{ type: "thought", text: "working" }, { type: "hang" }]);
        const request = newRequest();
        const turn = runTurn(h, request);
        await backendWaiting(h);
        request.abortController!.abort(new Error("conformance abort"));

        const { events } = await within(turn, PROMPT_END_MS, "ending an aborted turn");

        expect(ofType(activities(events), "response")).toEqual([]);
        if (!isExternal(h)) {
          expect(h.backend.turns[0]?.cancelled, "an abort must cancel local backend work").toBe(true);
        } else {
          expect(h.backend.turns[0]?.cancelled, "an abort alone is not a stop for external work").toBe(false);
        }
      });

      it("force-closes a hanging turn idempotently", async (context) => {
        const h = await setUp();
        if (h.runtime.forceCloseSession === undefined) {
          context.skip();
        }
        h.backend.enqueue([{ type: "thought", text: "working" }, { type: "hang" }]);
        const request = newRequest();
        const turn = runTurn(h, request);
        await backendWaiting(h);

        // The bridge aborts the controller and then force-closes; both may
        // arrive more than once and in either order.
        expect(() => h.runtime.forceCloseSession!(request)).not.toThrow();
        expect(() => h.runtime.forceCloseSession!(request)).not.toThrow();
        request.abortController!.abort(new Error("conformance force-close"));
        const { events } = await within(turn, PROMPT_END_MS, "ending a force-closed turn");
        expect(() => h.runtime.forceCloseSession!(request)).not.toThrow();

        expect(ofType(activities(events), "response")).toEqual([]);
        if (!isExternal(h)) {
          expect(h.backend.turns[0]?.cancelled).toBe(true);
        }
      });

      it("cancels external work on stopSession, idempotently", async (context) => {
        const h = await setUp();
        if (!isExternal(h)) {
          context.skip();
        }
        h.backend.enqueue([{ type: "thought", text: "working" }, { type: "hang" }]);
        const request = newRequest();
        let runtimeSessionId: string | undefined;
        const turn = runTurn(h, request, (event) => {
          if (event.kind === "session-started") {
            runtimeSessionId = event.runtimeSessionId;
          }
        });
        await backendWaiting(h);

        const stop = { linearSessionId: request.linearSessionId, runtimeSessionId };
        await within(h.runtime.stopSession!(stop), PROMPT_END_MS, "stopSession");
        request.abortController!.abort(new Error("conformance stop"));
        await within(turn, PROMPT_END_MS, "ending a stopped turn");
        await within(h.runtime.stopSession!(stop), PROMPT_END_MS, "a repeated stopSession");

        expect(h.backend.turns[0]?.cancelled).toBe(true);
      });

      it("reattaches to external work after a restart without starting it again", async (context) => {
        const h = await setUp();
        if (h.runtime.reattachAfterRestart !== true) {
          context.skip();
        }
        h.backend.enqueue([{ type: "thought", text: "before restart" }, { type: "gate" }, { type: "response", text: "after restart" }]);
        const first = newRequest();
        const dying = runTurn(h, first);
        await backendWaiting(h);
        first.abortController!.abort(new Error("process exit"));
        const before = await within(dying, PROMPT_END_MS, "detaching on abort");
        const sessionId = sessionIdOf(before.events);
        expect(sessionId).toBeDefined();
        expect(h.backend.turns[0]?.cancelled).toBe(false);

        const watch = runTurn(h, newRequest({ prompt: "", resumeSessionId: sessionId, watchOnly: true }));
        h.backend.release();
        const { events, error } = await within(watch, PROMPT_END_MS, "the reattached turn");

        expect(error).toBeUndefined();
        expect(h.backend.turns, "a watch-only turn must not start new work").toHaveLength(1);
        expect(ofType(activities(events), "response").map((a) => a.body)).toEqual(["after restart"]);
        expect(events.at(-1)).toEqual({ kind: "done" });
      });
    });

    describe("inside the bridge", () => {
      const responses = (b: TestBridge, sessionId: string): string[] =>
        b.posted.filter((p) => p.agentSessionId === sessionId && p.content.type === "response").map((p) => (p.content as { body: string }).body);
      const errors = (b: TestBridge, sessionId: string): AgentActivityContent[] =>
        b.posted.filter((p) => p.agentSessionId === sessionId && p.content.type === "error").map((p) => p.content);

      it("posts one final response for a created session and persists its runtime session", async () => {
        const h = await setUp();
        h.backend.enqueue([
          { type: "thought", text: "thinking" },
          { type: "tool", name: "search", input: { q: "x" }, output: "found" },
          { type: "response", text: "done here" },
        ]);
        bridge = await startBridge(h.runtime);

        expect((await bridge.deliver(createdEvent("s-created", "do the thing"))).status).toBe(200);
        await waitFor(() => responses(bridge!, "s-created").length > 0, "the final response");
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(responses(bridge, "s-created")).toEqual(["done here"]);
        expect(errors(bridge, "s-created")).toEqual([]);
        expect(h.backend.turns[0]?.prompt).toContain("do the thing");
        await waitFor(async () => (await bridge!.store.get("s-created")) !== undefined, "the session record");
        expect((await bridge.store.get("s-created"))?.runtimeSessionId).toBe(h.backend.turns[0]?.sessionId);
      });

      it("resumes the stored runtime session for a follow-up prompt", async () => {
        const h = await setUp();
        h.backend.enqueue([{ type: "response", text: "first" }]);
        h.backend.enqueue([{ type: "response", text: "second" }]);
        bridge = await startBridge(h.runtime);

        await bridge.deliver(createdEvent("s-resume", "start"));
        await waitFor(() => responses(bridge!, "s-resume").length === 1, "the first response");
        await bridge.deliver(promptedEvent("s-resume", "activity-follow-up", "and then?"));
        await waitFor(() => responses(bridge!, "s-resume").length === 2, "the second response");

        expect(h.backend.turns[1]?.resumeSessionId).toBe(h.backend.turns[0]?.sessionId);
        expect(h.backend.turns[1]?.prompt).toContain("and then?");
        expect(responses(bridge, "s-resume")).toEqual(["first", "second"]);
      });

      it("runs a duplicated delivery once and posts one response", async () => {
        const h = await setUp();
        h.backend.enqueue([{ type: "response", text: "only once" }]);
        bridge = await startBridge(h.runtime);
        const event = createdEvent("s-duplicate", "do it once");

        expect((await bridge.deliver(event, "delivery-a")).status).toBe(200);
        expect((await bridge.deliver(event, "delivery-a")).status).toBe(200);
        expect((await bridge.deliver(event, "delivery-b")).status).toBe(200);
        await waitFor(() => responses(bridge!, "s-duplicate").length > 0, "the response");
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(h.backend.turns).toHaveLength(1);
        expect(responses(bridge, "s-duplicate")).toEqual(["only once"]);
      });

      it("posts exactly one error, and no response, when the backend throws", async () => {
        const h = await setUp();
        h.backend.enqueue([{ type: "thought", text: "trying" }, { type: "throw", message: "backend exploded" }]);
        bridge = await startBridge(h.runtime);

        await bridge.deliver(createdEvent("s-throw", "fail please"));
        await waitFor(() => errors(bridge!, "s-throw").length > 0, "the error activity");
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(errors(bridge, "s-throw")).toHaveLength(1);
        expect(responses(bridge, "s-throw")).toEqual([]);
      });

      it("stops a silent turn at the inactivity limit", async () => {
        const h = await setUp();
        h.backend.enqueue([{ type: "hang" }]);
        bridge = await startBridge(h.runtime, { runInactivityTimeoutMs: 300 });

        await bridge.deliver(createdEvent("s-inactive", "go quiet"));
        await waitFor(
          () => errors(bridge!, "s-inactive").some((e) => "body" in e && e.body.includes("inactive")),
          "the inactivity error",
        );

        expect(responses(bridge, "s-inactive")).toEqual([]);
        if (!isExternal(h)) {
          await waitFor(() => h.backend.turns[0]?.cancelled === true, "the backend turn to be cancelled");
        }
      });

      it("cancels the backend on a Linear stop and posts no engine response", async () => {
        const h = await setUp();
        h.backend.enqueue([{ type: "thought", text: "working" }, { type: "hang" }]);
        bridge = await startBridge(h.runtime);

        await bridge.deliver(createdEvent("s-stop", "long task"));
        await backendWaiting(h);
        await bridge.deliver(promptedEvent("s-stop", "activity-stop", "stop", "stop"));
        await waitFor(() => h.backend.turns[0]?.cancelled === true, "the backend turn to be cancelled");
        await waitFor(() => responses(bridge!, "s-stop").length > 0, "the stop response");

        expect(responses(bridge, "s-stop").every((body) => body.startsWith("Stopped."))).toBe(true);
        expect(h.backend.turns).toHaveLength(1);
      });
    });
  });
}
