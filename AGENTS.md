# linear-agent-bridge: guide for coding agents

This repository bridges Linear's Agent Session API to an **engine**: an
`AgentRuntime` that does the work of a turn and streams events back. The most
common task here is adding or changing an engine, and that is safe to do on
your own. The bridge core is durable ingress, ordering, and recovery code with
invariants that are easy to break silently. Change it only test-first and after
reading [docs/architecture.md](docs/architecture.md).

## Where things live

- `src/types.ts`: the engine contract (`AgentRuntime`, `SessionRequest`,
  `RuntimeEvent`). It is the single source of truth for the contract; this file
  summarizes it.
- `src/runtime/`: the shipped engines, `claude.ts` and `codex.ts`. `prompt.ts`
  holds the session preamble every agent-backed engine prepends.
- `src/index.ts`: builds each app's engine from its config.
- `src/config.ts` and `src/apps-config.ts`: environment and `BRIDGE_APPS_FILE`
  parsing.
- `conformance/`: the engine conformance suite (`suite.ts`), its scripted
  backend kit (`kit.ts`), and harnesses for the shipped engines (`engines/`).
- `examples/`: reference engines with their harnesses and tests.
- Core, read [docs/architecture.md](docs/architecture.md) before editing:
  `src/server.ts`, `src/state/`, `src/queue.ts`, `src/linear/`,
  `src/shutdown.ts`, `deploy/`.

## Change zones

**Safe to change:**

- a new or existing engine under `src/runtime/` or `examples/`, together with
  its harness;
- engine wiring in `src/index.ts` and the `runtime`/`target` values in
  `src/config.ts` and `src/apps-config.ts`;
- configuration defaults, docs, and tests.

**Core:** everything else under `src/`, plus `deploy/`. Any change there needs
a failing test first and must keep every invariant below true.

## Invariants

Each rule names the check that guards it. Run that check after any change near
it, and keep it green.

| # | Invariant | Check |
|---|---|---|
| 1 | A webhook is acknowledged within 5 s, and only after its receipt and semantic claim are durable. No other work precedes the ack. | `test/server.test.ts`: "returns 503 with headroom before Linear's five-second deadline" |
| 2 | Per-delivery identity is the `Linear-Delivery` header, never `webhookId`. A turn's identity is `created:<sessionId>` or the prompt's `agentActivity.id`. | `test/server.test.ts`: "processes two deliveries that share a webhookId", "still deduplicates a genuine retry"; conformance "runs a duplicated delivery once" |
| 3 | A turn runs at most once. A retry after its durable dispatch marker is recorded as ambiguous and not run. | `test/server.test.ts`: "surfaces a post-dispatch retry as ambiguous without running it again" |
| 4 | Turns in one Linear session run FIFO; different sessions run concurrently. | `test/queue.test.ts`: "executes one session's tasks in strict FIFO order", "runs different session lanes concurrently" |
| 5 | A stop aborts active and queued turns for its session and sets a durable fence that older work cannot cross. | `test/server.test.ts`: "a stop signal aborts the active turn", "a delayed stop older than the durable fence cannot abort newer resumed work"; conformance "cancels the backend on a Linear stop" |
| 6 | The inactivity limit measures runtime silence, not wall-clock time. `progress` resets it; `done` ends the turn. | conformance "stops a silent turn at the inactivity limit" |
| 7 | Each turn posts at most one final response, and a failed turn posts exactly one error. | conformance "posts one final response", "posts exactly one error, and no response" |
| 8 | Reconciliation's first sighting of a session dispatches nothing, except a lost `created` inside the documented window. | `test/server.test.ts`: "adopts a watermark without dispatching on a session it has never reconciled", "recovers a session whose created webhook was lost, exactly once" |
| 9 | A webhook routes to the one app whose secret verifies its signature, and the payload must name that app. | `test/multi-app-server.test.ts`: "routes a delivery to the app whose signing secret verifies it", "rejects a verified delivery whose payload names another app" |
| 10 | The rotating OAuth pair is persisted atomically after every authorization and refresh. Tokens are never logged. | `test/linear.test.ts`: "refreshes an expired OAuth token, persists the rotated pair, and retries once" |
| 11 | Shipped engines pass no model, effort, tool, or permission overrides beyond the documented unattended posture, and never set the subprocess environment. | `test/claude-runtime.test.ts`: "never overrides env", "never sets model or tool allowlists"; `test/codex-runtime.test.ts`: "starts a Codex thread with service defaults intact" |
| 12 | Every agent prompt carries the Linear session preamble, so the agent leaves posting its final response to the bridge. | `test/runtime-prompt.test.ts`; the prompt assertions in both runtime tests |

## The engine contract

`runSession(request)` runs one turn and returns an async iterable of
`RuntimeEvent`s. The bridge consumes it in `runSessionTask` in `src/server.ts`.
A conforming engine does the following, and the conformance suite checks each
point:

1. **Session.** On a fresh turn, yield `session-started` with the backend's
   conversation id before any activity. When `request.resumeSessionId` is set,
   continue that conversation. Reporting `session-started` again on a resumed
   turn is optional, but it must carry the same id.
2. **Activities.** A `thought` is interim and renders ephemerally. An `action`
   without `result` opens a tool card; close it later with an `action` that has
   the same `action` and `parameter` plus a `result`. Close a failed tool's card
   too. Yield exactly one `response` per successful turn.
3. **End.** Yield `done` last. Nothing follows it.
4. **Liveness.** Yield `progress` for every raw backend event, including events
   you buffer or hide. It resets the inactivity watchdog and never renders.
   Stay silent while the backend is idle, so the watchdog can do its job.
5. **Failure.** Throw from the iterator: on a backend error, a broken stream, or
   a nonzero exit. The bridge posts the error's message as the turn's one
   error activity, so the message must be safe to show in Linear. Keep secrets,
   command lines, stderr, and raw provider bodies out of it. Use an `error`
   activity only for a failure the backend reported inside a turn that still
   ends normally.
6. **Abort.** Honor `request.abortController` promptly. End the iterator, by
   returning or with `done`, within two seconds; the suite enforces that bound.
   A local engine also cancels its backend work. It may finish releasing that
   work in the background, for example by escalating a child process from
   SIGTERM to SIGKILL, but must not leave it running. An abort also comes from
   shutdown and the inactivity limit, so it is never a stop for work that lives
   outside the process.
7. **Configuration.** Leave model, effort, and tool selection to the backend's
   own configuration. The shipped agent engines inherit the service environment
   on purpose, because that is where their credentials live. That environment
   also holds the bridge's Linear secrets, so an engine that runs other
   commands should pass them an explicit, minimal environment. Prepend the
   session preamble with `withLinearAgentSessionContext` whenever the backend
   is an agent that could otherwise post its answer to Linear itself.

Optional hooks, all declared in `src/types.ts`:

| Hook | Implement it when |
|---|---|
| `forceCloseSession(request)` | The engine holds a resource the bridge may need to close synchronously on timeout. Must be idempotent and never throw. |
| `stopSession(session)` | Work continues outside this process. This is the only place that work is cancelled; declaring it makes the suite treat the engine as external. |
| `stopForClosedIssue(session)` | Work continues outside this process and should end when its Linear issue is completed or cancelled. Returns `{ stopped }`, true only if it ended live work. |
| `reattachAfterRestart` + `request.watchOnly` | The external work survives a bridge restart. A watch-only turn resumes watching `resumeSessionId` and must not submit new work. |
| `{ kind: "watching" }` event | The turn has handed off and is only watching, so a newer prompt may supersede the watch. |
| `needsTurnContext` | The engine needs `turnId`, the bridge's stable turn id and a good idempotency key, or `issueIdentifier`. |
| `suppressProgressNotices` | The engine posts its own bounded progress, so the bridge's periodic "Still working" notices would duplicate it. |
| `sharedWork` on `session-started`, `stableKey` on elicitations | See their comments in `src/types.ts`. |

## Add an engine

Work through these steps in order. Each step ends at its stated done-state.

1. **Read the contract.** Read `src/types.ts`, `conformance/kit.ts`, and the
   scenarios in `conformance/suite.ts`, then the example closest to your
   backend (see [Examples](#examples)). Done when you can say which optional
   hooks your engine needs.
2. **Write the engine** at `src/runtime/<name>.ts`, or under
   `examples/<name>/` for an out-of-tree engine. Inject the backend client
   through the constructor so a harness can fake it. Done when it typechecks.
3. **Write the harness** at `conformance/engines/<name>.ts`, or
   `examples/<name>/harness.ts`. It default-exports
   `defineEngine({ name, createHarness })`. `createHarness` returns
   `{ runtime, backend, dispose? }`, where `backend` is a `ScriptedBackend` and
   the runtime talks to a fake of your backend wired to it:
   - call `backend.startTurn({ prompt, resumeSessionId })` when the engine
     starts a backend turn, and use `turn.record.sessionId` as the backend's
     conversation id;
   - translate each step from `turn.steps()` (thought, tool, response, throw)
     into your backend's native events;
   - call `turn.cancel()` when the engine cancels that work, whether by abort,
     close, or cancel request.

   The kit handles `hang` and `gate` steps. The fake proves the contract, not
   the transport. When the engine spawns processes or opens connections, also
   write tests against a real child or a local server. Those tests cover
   startup, exit codes, signals, and cleanup, and must leave no process
   running. Done when the harness typechecks.
4. **Run the suite:** `npm run test:engine -- <harness path>`. Done when every
   scenario passes and every skip is explained by a hook you left out. The
   force-close scenario skips without `forceCloseSession`, the stop scenario
   without `stopSession`, and the reattach scenario without
   `reattachAfterRestart`. A failure means the engine is wrong; fix the engine,
   not the suite.
5. **Register it.** Add the harness to `conformance/builtin.test.ts`, or add a
   `conformance.test.ts` beside an example, so `npm test` runs it. Add focused
   unit tests for engine-specific mapping, such as truncation and error
   sanitizing.
6. **Wire it in**, if the bridge should be able to select it. Only engines
   under `src/runtime/` can be selected, because the build compiles `src/`
   alone; move an example there first. Add the name to `Config.runtime` and the
   `RUNTIME` check in `src/config.ts`, to `buildRuntime` in `src/index.ts`,
   and, for additional apps, to `parseAppTarget` in `src/apps-config.ts`. Done
   when `config.test.ts` covers the new value and `npm run build` succeeds.
7. **Run the gates** (below). Done when all are green.

## Examples

These go from simplest to most complex. Read the one closest to your backend.

1. **In-process stream:** [examples/stream-engine](examples/stream-engine).
   About 80 lines. A library streams session, text, and tool events for one
   turn, and the engine maps them one-to-one. Start here.
2. **Agent SDK:** `src/runtime/claude.ts` and `src/runtime/codex.ts`, with
   harnesses in `conformance/engines/`. They add real-world mapping:
   - Claude holds each thought back one step and drops it if the final response
     repeats it;
   - tool results are correlated to their calls by id;
   - Codex reduces provider errors to a fixed set of safe messages and checks
     that a resumed thread keeps its id.
3. **External orchestrator:**
   [examples/http-job-engine](examples/http-job-engine). The work runs in
   another system behind an HTTP job API. The engine submits with `turnId` as
   the idempotency key, emits `watching`, and polls, yielding `progress` only
   for new events. Abort only detaches; `stopSession` and `stopForClosedIssue`
   cancel. After a restart, `reattachAfterRestart` watches the same job
   instead of starting another. It ships with a fake HTTP server, so its suite
   runs offline.

## Gates

This repository has no CI and no lint script; verification is local. Before
every commit:

- `npm run typecheck`: the build config over `src/`, then
  `tsconfig.check.json` over `src/`, `conformance/`, and `examples/`.
- `npm test`: unit tests, the conformance suite for every in-repo engine, and
  the examples.

Before a merge or a deploy, run the full gate on Node 22 from a clean checkout:

```bash
npm ci
bash -n deploy/install.sh deploy/run.sh deploy/verify-ingress.sh
node --check deploy/parse-funnel-status.mjs
python3 -m py_compile deploy/tcp_forward.py test/test_tcp_forward.py
python3 -m unittest discover -s test -p 'test_tcp_forward.py'
npm run typecheck
npm test
npm run test:install
npm run build
```

Tests use synthetic payloads and temporary stores. Keep them deterministic:
never start a live bridge, post to Linear, or use real credentials in a test.
Commit test changes before or together with the implementation they cover.
