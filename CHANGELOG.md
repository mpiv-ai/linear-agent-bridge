# Changelog

## Unreleased

- Additional apps can set their own working directory (`kbPath`) and output
  folder (`agentOutputPath`) in `BRIDGE_APPS_FILE`. Previously every app ran
  in the default app's `KB_PATH`, although the docs said otherwise. An app's
  `agentOutputPath` is checked at startup the way `AGENT_OUTPUT_PATH` is.
- The README states the data flow precisely: the bridge process contacts only
  Linear, and the agent can reach anything its service account can.
- The operations guide explains that a bridge killed with `SIGKILL` outside
  the installed service can leave its agent running.

## 0.2.0

First public version. Earlier development happened in a private repository;
its history is not included here.

- Runs Claude (Agent SDK) or Codex (Codex SDK) as a Linear agent, with
  durable webhook ingress, per-session FIFO turns, stop handling, inactivity
  limits, reconciliation of missed webhooks, and rotating OAuth tokens.
- Claude authenticates with `ANTHROPIC_API_KEY` by default; a stored Claude
  Code login is supported for a single operator.
- Serves additional Linear apps from one process with `BRIDGE_APPS_FILE`,
  using the authorization-code or client-credentials flow per app.
- Pluggable engines: the `AgentRuntime` contract, an engine conformance suite
  (`npm run test:engine -- <harness>`), and two reference engines
  (`examples/stream-engine`, `examples/http-job-engine`).
- Opt-in autonomous goals, gated by an issue label.
