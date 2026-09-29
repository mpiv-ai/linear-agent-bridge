// Reference engine for the orchestrator pattern: the agent's work runs in
// another system behind a small HTTP job API, and this runtime only submits
// it, watches it, and cancels it on request. See README.md for the API.

import { randomUUID } from "node:crypto";
import type { AgentActivityContent, AgentRuntime, RuntimeEvent, SessionRequest } from "../../src/types.js";

export interface HttpJobRuntimeOptions {
  baseUrl: string;
  /** Sent as `Authorization: Bearer`. Never logged or put in an error. */
  token?: string;
  /** Delay between polls of a running job. Default 1000. */
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

type JobState = "running" | "succeeded" | "failed" | "cancelled";

interface JobEvent {
  seq: number;
  type: "thought" | "tool_started" | "tool_finished" | "response";
  text?: string;
  name?: string;
  input?: unknown;
  output?: string;
}

interface EventPage {
  events: JobEvent[];
  state: JobState;
  error?: string;
}

/** A non-2xx reply. Carries only the status, never a server-supplied body. */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`${what} failed with HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
/** Consecutive transient poll failures tolerated before the turn fails. */
const MAX_POLL_FAILURES = 3;
const MAX_TEXT = 1000;
const MAX_RESPONSE = 20_000;

/** Cap remote text, which is untrusted input, at a length safe to post. */
function truncate(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

/** Single-line, capped rendering of a value for card fields and errors. */
function oneLine(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

function isTransient(error: unknown): boolean {
  return !(error instanceof HttpStatusError) || error.status >= 500;
}

export class HttpJobRuntime implements AgentRuntime {
  readonly name = "http-job";
  // The remote thread and its job outlive this process, so a restarted
  // bridge can watch the job it left behind instead of failing the turn.
  readonly reattachAfterRestart = true;
  // turnId is the idempotency key: a redelivered turn cannot start a second job.
  readonly needsTurnContext = true;

  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly fetchFn: typeof fetch;
  // Local poll loops per request, so forceCloseSession can end one.
  private readonly loops = new WeakMap<SessionRequest, AbortController>();
  private readonly closed = new WeakSet<SessionRequest>();

  constructor(options: HttpJobRuntimeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.fetchFn = options.fetch ?? fetch;
  }

  async *runSession(request: SessionRequest): AsyncGenerator<RuntimeEvent> {
    const loop = new AbortController();
    this.loops.set(request, loop);
    // Aborting the turn (shutdown, inactivity, a superseding prompt) only
    // ends this watch. The remote job keeps running; only stopSession cancels.
    const outer = request.abortController?.signal;
    const detach = (): void => loop.abort();
    outer?.addEventListener("abort", detach, { once: true });
    if (outer?.aborted === true || this.closed.has(request)) {
      loop.abort();
    }
    try {
      yield* this.run(request, loop.signal);
    } catch (error) {
      if (!loop.signal.aborted) {
        throw error;
      }
    } finally {
      outer?.removeEventListener("abort", detach);
      this.loops.delete(request);
    }
    yield { kind: "done" };
  }

  forceCloseSession(request: SessionRequest): void {
    this.closed.add(request);
    this.loops.get(request)?.abort();
  }

  async stopSession(session: {
    linearSessionId: string;
    runtimeSessionId?: string | undefined;
    sharedWork?: boolean | undefined;
  }): Promise<string | undefined> {
    // A joining session only linked work another session owns.
    if (session.runtimeSessionId === undefined || session.sharedWork === true) {
      return undefined;
    }
    return (await this.cancel(session.runtimeSessionId)) ? "The remote job was cancelled." : undefined;
  }

  async stopForClosedIssue(session: {
    linearSessionId: string;
    runtimeSessionId?: string | undefined;
  }): Promise<{ stopped: boolean }> {
    if (session.runtimeSessionId === undefined) {
      return { stopped: false };
    }
    return { stopped: await this.cancel(session.runtimeSessionId) };
  }

  private async *run(request: SessionRequest, signal: AbortSignal): AsyncGenerator<RuntimeEvent> {
    const reattach = request.watchOnly === true && request.resumeSessionId !== undefined;
    let threadId: string;
    let jobId: string;
    if (reattach) {
      threadId = request.resumeSessionId!;
      const current = await this.call<{ jobId: string }>("GET", `/threads/${enc(threadId)}/jobs/current`, undefined, signal);
      jobId = current.jobId;
    } else {
      const body = { prompt: request.prompt, idempotencyKey: request.turnId ?? randomUUID() };
      if (request.resumeSessionId === undefined) {
        ({ threadId, jobId } = await this.call<{ threadId: string; jobId: string }>("POST", "/threads", body, signal));
      } else {
        threadId = request.resumeSessionId;
        ({ jobId } = await this.call<{ jobId: string }>("POST", `/threads/${enc(threadId)}/jobs`, body, signal));
      }
    }
    yield { kind: "session-started", runtimeSessionId: threadId };
    yield { kind: "watching" };

    let after = 0;
    let response: string | undefined;
    let replay = reattach; // the first page after a reattach is history the bridge already showed
    let failures = 0;
    for (;;) {
      signal.throwIfAborted();
      let page: EventPage;
      try {
        page = await this.call<EventPage>("GET", `/jobs/${enc(jobId)}/events?after=${after}`, undefined, signal);
        failures = 0;
      } catch (error) {
        if (signal.aborted || !isTransient(error) || ++failures >= MAX_POLL_FAILURES) {
          throw error;
        }
        await sleep(this.pollIntervalMs, signal);
        continue;
      }
      // Progress only when something new arrived, so the bridge's
      // inactivity limit still catches a job that has gone silent.
      if (page.events.length > 0) {
        yield { kind: "progress" };
      }
      for (const event of page.events) {
        after = Math.max(after, event.seq);
        if (event.type === "response") {
          response = truncate(event.text ?? "", MAX_RESPONSE);
        } else if (!replay) {
          yield { kind: "activity", activity: toActivity(event) };
        }
      }
      replay = false;
      if (page.state === "failed") {
        throw new Error(`The remote job failed: ${oneLine(page.error ?? "no reason given", 500)}`);
      }
      if (page.state === "succeeded") {
        if (response === undefined) {
          throw new Error("The remote job finished without a response.");
        }
        yield { kind: "activity", activity: { type: "response", body: response } };
        return;
      }
      if (page.state === "cancelled") {
        return;
      }
      await sleep(this.pollIntervalMs, signal);
    }
  }

  private async cancel(threadId: string): Promise<boolean> {
    const result = await this.call<{ cancelled: boolean }>("POST", `/threads/${enc(threadId)}/cancel`, {}, undefined);
    return result.cancelled;
  }

  private async call<T>(method: string, path: string, body: unknown, signal: AbortSignal | undefined): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpStatusError(response.status, `${method} ${path.split("?")[0]}`);
    }
    return (await response.json()) as T;
  }
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Card text is derived from name and input alone, so open and close match. */
function toActivity(event: JobEvent): AgentActivityContent {
  if (event.type === "thought") {
    return { type: "thought", body: truncate(event.text ?? "") };
  }
  const action = oneLine(event.name ?? "tool", 100);
  const parameter = oneLine(event.input ?? "", 200);
  return event.type === "tool_finished"
    ? { type: "action", action, parameter, result: truncate(event.output ?? "") }
    : { type: "action", action, parameter };
}

/** Resolves after ms, or immediately once the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
