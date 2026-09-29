# HTTP job engine

A small reference engine for the orchestrator pattern. Use it as a starting
point when the agent's work runs in another system that outlives the bridge
process: a job service, a workflow engine, a hosted agent platform. The
runtime does not run the agent. It submits the work, watches it, and cancels
it when Linear says stop. If the bridge restarts, the work keeps going, and
the restarted bridge reattaches to it instead of reporting an interruption.

`HttpJobRuntime` in `engine.ts` implements `AgentRuntime` against the generic
API below. `fake-server.ts` is a real `node:http` server that implements the
same API over the conformance `ScriptedBackend`, so the engine is tested over
actual HTTP without any external service.

## The API

All requests carry `Authorization: Bearer <token>` when a token is configured.
The token is never logged or included in an error message.

| Request | Reply |
| --- | --- |
| `POST /threads` `{prompt, idempotencyKey}` | `{threadId, jobId}`. Starts a conversation. |
| `POST /threads/:threadId/jobs` `{prompt, idempotencyKey}` | `{jobId}`. Continues one. |
| `GET /jobs/:jobId/events?after=<seq>` | `{events, state, error?}` |
| `GET /threads/:threadId/jobs/current` | `{jobId, state}` for the thread's latest job, or 404 if it has none. |
| `POST /threads/:threadId/cancel` | `{cancelled}`, true only if this call ended live work. Idempotent. |

- The same `idempotencyKey` returns the same job and never starts a second.
- `state` is `running`, `succeeded`, `failed`, or `cancelled`. `error` is set
  on `failed`.
- Events carry an increasing `seq`, and `after` returns only later ones. Types:
  `thought {text}`, `tool_started {name, input}`, `tool_finished {name, input,
  output}`, and `response {text}`. Both tool events carry the same name and
  input, so the runtime can close the action card it opened.
- `current` reports the latest job even after it finished, so a bridge that
  was down when the job completed can still fetch its response.

## Behavior

The thread id is the runtime session id. A turn yields `session-started` right
after submission, then `watching`, then polls. It yields `progress` only when
a poll returned new events, so the bridge's inactivity limit still fires on a
job that has gone silent. Events become thoughts and action cards, and the
single response is posted once the job succeeds. A `failed` job throws an
error with a bounded message; a `cancelled` job ends without a response.
Transient poll failures (network errors, 5xx) are retried up to three times in
a row.

## Optional hooks used

- `needsTurnContext`: `request.turnId` becomes the idempotency key, so a
  redelivered turn cannot start a second job.
- `reattachAfterRestart`: a watch-only turn with `resumeSessionId` reads the
  thread's current job and watches it without submitting. Events from the
  first page are history the bridge already showed, so only the response is
  kept from it.
- `stopSession`: the one place remote work is cancelled. Aborting a turn
  (shutdown, inactivity, a newer prompt) only ends the local watch, because
  the work lives elsewhere. It does nothing for a session that only linked
  work another session owns (`sharedWork`).
- `stopForClosedIssue`: cancels the same way and reports `{stopped: true}` only
  when it ended live work, so the bridge owes the session one response.
- `forceCloseSession`: ends this process's poll loop idempotently and never
  cancels remote work.

## Running it

From the repository root:

    npx vitest run examples/
    npm run test:engine -- examples/http-job-engine/harness.ts

The first runs the engine's own tests and the conformance suite; the second
runs only the conformance suite through the same entry point used for any
external engine. Every scenario runs, none skip. To adapt this to a real
service, change the paths and event mapping in `engine.ts`, then replace the
fake server with a harness that plays each `ScriptedBackend` turn against your
service (or a faithful fake of it).
