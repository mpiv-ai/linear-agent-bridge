// A real HTTP server implementing the job API in README.md, with the
// conformance ScriptedBackend as the "remote system" doing the work. Jobs
// live in this server's memory, not in the runtime, so a fresh runtime can
// reattach to them the way a restarted bridge would.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BackendTurnHandle, ScriptedBackend } from "../../conformance/kit.js";

export interface FakeJobServer {
  readonly url: string;
  close(): Promise<void>;
}

type JobState = "running" | "succeeded" | "failed" | "cancelled";

interface Job {
  id: string;
  threadId: string;
  turn: BackendTurnHandle;
  events: Array<Record<string, unknown>>;
  state: JobState;
  error?: string;
}

export async function startFakeJobServer(
  backend: ScriptedBackend,
  options: { token?: string } = {},
): Promise<FakeJobServer> {
  const jobs = new Map<string, Job>();
  const threads = new Map<string, Job[]>();
  const byKey = new Map<string, Job>();

  /** Play the turn's steps into the job's event log, in the background. */
  async function play(job: Job): Promise<void> {
    let responded = false;
    for await (const step of job.turn.steps()) {
      const seq = job.events.length + 1;
      if (step.type === "thought") {
        job.events.push({ seq, type: "thought", text: step.text });
      } else if (step.type === "tool") {
        const card = { name: step.name, input: step.input };
        job.events.push({ seq, type: "tool_started", ...card });
        job.events.push({ seq: seq + 1, type: "tool_finished", ...card, output: step.output });
      } else if (step.type === "response") {
        responded = true;
        job.events.push({ seq, type: "response", text: step.text });
      } else {
        job.state = "failed";
        job.error = step.message;
        return;
      }
    }
    if (job.state === "running") {
      job.state = responded ? "succeeded" : "failed";
      if (!responded) {
        job.error = "the job ended without a response";
      }
    }
  }

  function createJob(threadId: string | undefined, prompt: string, key: string): Job {
    const scoped = `${threadId ?? ""}:${key}`;
    const existing = byKey.get(scoped);
    if (existing !== undefined) {
      return existing;
    }
    const turn = backend.startTurn({ prompt, resumeSessionId: threadId });
    const job: Job = { id: `job-${randomUUID()}`, threadId: turn.record.sessionId, turn, events: [], state: "running" };
    jobs.set(job.id, job);
    byKey.set(scoped, job);
    threads.set(job.threadId, [...(threads.get(job.threadId) ?? []), job]);
    void play(job);
    return job;
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : "internal error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";
    const body = method === "POST" ? await readJson(req) : {};

    if (method === "POST" && path.length === 1 && path[0] === "threads") {
      const job = createJob(undefined, str(body.prompt), str(body.idempotencyKey));
      send(res, 200, { threadId: job.threadId, jobId: job.id });
      return;
    }
    const [root, threadId, leaf, sub] = path;
    if (root === "threads" && threadId !== undefined) {
      const thread = threads.get(threadId);
      if (method === "POST" && leaf === "jobs" && sub === undefined) {
        if (thread === undefined) {
          return send(res, 404, { error: "no such thread" });
        }
        const job = createJob(threadId, str(body.prompt), str(body.idempotencyKey));
        return send(res, 200, { jobId: job.id });
      }
      if (method === "GET" && leaf === "jobs" && sub === "current") {
        const current = thread?.at(-1);
        return current === undefined ? send(res, 404, { error: "no job" }) : send(res, 200, { jobId: current.id, state: current.state });
      }
      if (method === "POST" && leaf === "cancel") {
        const live = thread?.filter((job) => job.state === "running") ?? [];
        for (const job of live) {
          job.state = "cancelled";
          job.turn.cancel();
        }
        return send(res, 200, { cancelled: live.length > 0 });
      }
    }
    if (root === "jobs" && method === "GET" && leaf === "events" && threadId !== undefined) {
      const job = jobs.get(threadId);
      if (job === undefined) {
        return send(res, 404, { error: "no such job" });
      }
      const after = Number(url.searchParams.get("after") ?? 0);
      return send(res, 200, {
        events: job.events.filter((event) => (event.seq as number) > after),
        state: job.state,
        ...(job.error === undefined ? {} : { error: job.error }),
      });
    }
    send(res, 404, { error: "not found" });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const job of jobs.values()) {
        job.turn.cancel();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}
