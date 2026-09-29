# How we run it: a team of agents in Linear

We use this bridge to put several specialist agents into one Linear workspace.
Each agent is a Linear teammate that people mention, delegate issues to, and
stop when needed, and each one works with the context it needs. This page
describes that setup so you can build your own. Names in angle brackets are
placeholders.

## The shape

```
                    Linear workspace
   @<builder>   @<researcher>   @<writer>      one Linear app per agent
        \            |             /
         signed webhooks, one URL
                     |
            linear-agent-bridge                one process, one listener
   app <builder>  -> engine: Claude     cwd: <project checkout>
   app <researcher> -> engine: Codex    cwd: <research notes>
   app <writer>   -> engine: agent workbench (external, agent-written)
```

Each agent is its **own Linear OAuth app**, so it has its own name, avatar,
and permissions in Linear. It is installed with `actor=app`, which makes it
assignable and mentionable, and everything it posts appears under its own name.

One bridge process serves them all. The default app comes from `.env`, and the
others from a `BRIDGE_APPS_FILE`. Every app has its own signing secret, token
store, and state directory, and the bridge routes each webhook to the one app
whose secret verifies it. See [operations: additional apps](operations.md#additional-apps).

The additional apps use the **client-credentials** flow, so adding an agent
doesn't need a browser authorization step. When Linear doesn't open a session
for a delegation, the bridge opens one itself and dispatches it through the
same durable path as a webhook, so the work never runs twice.

## Choosing an engine per agent

The engine is the part of each app that does the work, and every app picks its
own.

- **Claude or Codex in a working directory.** Most of our agents run like this.
  The working directory is what gives each agent its context: its
  `CLAUDE.md` or `AGENTS.md`, skills, and MCP servers. A research agent points
  at notes, and a build agent points at a checkout. Each runs as a service
  account with an API key. Its working tree is read-only, and it has one
  writable output folder (see
  [confining what the agent can write](operations.md#confining-what-the-agent-can-write)).
- **An external workbench.** Some of our agents hand each Linear session to BB,
  the agent workbench we use day to day, which runs it as a durable thread. The
  work outlives the bridge, so the engine uses the optional hooks for that
  case:
  - `watching`, because the turn only watches work running elsewhere;
  - `stopSession`, because a Linear stop cancels the thread and an abort alone
    does not;
  - `reattachAfterRestart`, so a restarted bridge watches the same thread
    instead of starting a new one.

  **A coding agent wrote that engine.** It stays private because it targets
  our own workbench. The pattern is public as
  [examples/http-job-engine](../examples/http-job-engine), and the lessons from
  building it are now the contract in [AGENTS.md](../AGENTS.md) and the checks
  in the conformance suite.

If you want an engine for your own system, point your coding agent at
`AGENTS.md`. It has the contract, the invariants, and
`npm run test:engine -- <harness>`, which tells the agent whether the engine is
correct.

## Running it

- **Ingress.** The bridge listens on loopback only. A tunnel publishes one
  HTTPS path, `https://<public-host>/webhook`, to it. We use Tailscale Funnel;
  [docs/ingress-cutover.md](ingress-cutover.md) covers changing the webhook URL
  safely.
- **Service.** On Linux, the installer sets up a systemd unit that runs as a
  dedicated account; on macOS it sets up a launchd agent. Credentials sit in
  `.env` (mode 0600), and each additional app's secrets are referenced by file
  path.
- **Longer work.** Autonomous goals are opt-in per issue with a label. Without
  the label, each message is one turn. With it, the agent keeps working in
  bounded steps until it claims completion with a verification summary, and
  the bridge rechecks the label before closing the issue.
- **Recovery.** Every accepted webhook is persisted before the 5-second ack, so
  a restart resumes accepted work rather than losing it. Reconciliation catches
  webhooks that never arrived.

## Things we learned the hard way

- **Delivery identity.** Key webhook deduplication on the `Linear-Delivery`
  header. `webhookId` names the webhook configuration and repeats on every
  delivery.
- **Queued or lost.** For the first minute, a queued message and a lost one
  look the same. The bridge posts a liveness thought within seconds of
  accepting a turn, so if a session shows nothing at all, the webhook never
  arrived.
- **The opening comment.** The comment that opens a session never becomes an
  activity, and it arrives only in the `created` webhook. If that webhook is
  lost, the text is gone. The bridge can detect the loss but cannot replay it.
- **One answer per turn.** Agents like to post their answer as a comment too.
  Every prompt tells the agent the bridge posts its final response, so it
  doesn't post twice.
- **Shared workspaces.** Use an API key when other people can reach the
  agent. Anyone who can mention it directs work on the account it runs as (see
  [Claude authentication](../README.md#claude-authentication)).
