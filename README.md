# linear-agent-bridge

Run Claude Code or Codex as a Linear agent. Delegate an issue to it or message
it in an agent session, and the selected runtime works on your machine in a
directory you choose, with the instructions, MCP servers, and skills available
to that runtime. Replies land in the issue's agent-session thread.

This is a compact reference implementation (no framework, tested) with a
pluggable engine seam. Claude and Codex ship with it, and you can add your own
(see [Engines](#engines)). It is not a coding agent; for
assign-an-issue-get-a-PR flows, see [Cyrus](https://github.com/ceedaragents/cyrus).
This bridge is for talking to an agent that knows your context: a knowledge
base, an ops repo, a project directory.

The Claude runtime calls the Claude Agent SDK's `query()` and authenticates
with an Anthropic API key by default (see
[Claude authentication](#claude-authentication)). The Codex runtime uses the
Codex SDK and the service account's Codex login.

Status: a self-hosted, single-operator tool, maintained on a best-effort basis.
Questions and bug reports go to [GitHub Issues](../../issues).

## How it works

```
Linear mention, delegation, or follow-up
  -> signed webhook to /webhook   verified, durably recorded, acknowledged < 5s
  -> per-session FIFO lane        one turn at a time per Linear session
  -> engine (AgentRuntime)        Claude, Codex, or your own
  -> Linear agent activities      thoughts, tool cards, one final response
```

Follow-ups resume the same conversation. Webhook retries never run a turn
twice, accepted work survives a restart, and missed webhooks are recovered by
reconciliation. [docs/architecture.md](docs/architecture.md) explains why each
rule exists, and [docs/how-we-run-it.md](docs/how-we-run-it.md) shows a
multi-agent setup.

## Prerequisites

- Node 22+ and a machine that stays on.
- Credentials for the selected runtime, available to the user who runs the
  service. For `RUNTIME=claude`, an Anthropic API key from the
  [Claude Console](https://console.anthropic.com/) (recommended), or a stored
  Claude Code login if you run the bridge only for yourself. For
  `RUNTIME=codex`, a Codex login on the service account.
- On macOS, Xcode Command Line Tools (`xcode-select --install`). The build uses
  the supported libproc API to compile a small local process-identity helper.
- A Linear workspace where you can create OAuth applications (workspace
  admin) and authorize one as an agent.
- A public HTTPS route to the loopback-bound service. The supported deployment
  topology uses Tailscale Funnel directly on the bridge host.


## Setup

```bash
umask 077
npm install
cp .env.example .env && chmod 600 .env
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
# in .env: LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET,
# INGRESS_RECOVERY_KEY (the value above), ANTHROPIC_API_KEY, KB_PATH
npm run dev
```

1. Create a Linear OAuth application with webhooks on and **Agent session
   events** checked.
2. Configure `.env` and run `npm run dev`. It loads `.env`; `npm start` does not.
3. Open the authorization URL the service prints, and install the app as an
   agent (`actor=app`).
4. Expose `/webhook` over public HTTPS and point the app's webhook URL at it.
5. Mention the agent or delegate an issue to it.

[docs/operations.md](docs/operations.md) walks through each step and covers the
installer, ingress, autonomous goals, additional apps, and field notes.

## Claude authentication

The Claude runtime runs each turn through the Claude Agent SDK's `query()`,
which starts the Claude Code runtime bundled with the SDK as a subprocess. The
bridge never sets the subprocess environment, so it inherits the service's.

**Use an API key.** Set `ANTHROPIC_API_KEY` in `.env`. When it is set it takes
precedence over any Claude Code login stored on the service account, and usage
is billed to your Claude Console organization under the
[Commercial Terms](https://www.anthropic.com/legal/commercial-terms). This is
the right setup for any workspace where someone other than you can mention the
agent or delegate to it.

**Subscription login, for one person only.** If `ANTHROPIC_API_KEY` is unset,
Claude runs use the service account's Claude Code login: the one stored by
running `claude` and `/login` as that account, or a `CLAUDE_CODE_OAUTH_TOKEN`
from `claude setup-token` set in `.env`. Usage draws from that person's Pro or
Max plan limits. Do this only when you run the bridge
for yourself and nobody else in the Linear workspace can reach the agent.

> **Warning:** Every Linear user who can mention or delegate to the agent runs
> work on the account the bridge uses. On a personal Pro or Max login, that
> means your teammates' requests run on your subscription. Anthropic's
> [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) prohibit
> making your account available to anyone else, and Anthropic's
> [legal and compliance notes](https://code.claude.com/docs/en/legal-and-compliance)
> say Pro and Max limits assume ordinary individual use. Use an API key for a
> shared workspace.

The service logs which credential each run used, without the credential
itself: `[claude] session auth: ANTHROPIC_API_KEY` or
`[claude] session auth: Claude Code login`. At startup, a Claude runtime with
no `ANTHROPIC_API_KEY` logs a one-line reminder of the single-user limit.

The bridge passes no model, tool, or permission overrides beyond
`permissionMode: "bypassPermissions"`. The service account's Claude Code
settings (`~/.claude/settings.json`) and the working directory's `CLAUDE.md`
and `.claude/` configuration choose the model and load MCP servers and skills.

The Codex adapter uses the Codex SDK with the service account's Codex login and
`~/.codex/config.toml`. The same single-user caution applies to a personal
ChatGPT plan login.

## Trust boundaries

### Permissions and credentials

| What | Where it lives | Used for |
| --- | --- | --- |
| Linear OAuth client ID and secret | `.env` | Authorizing the app and refreshing its token |
| Linear webhook signing secret | `.env` | Verifying every webhook (HMAC-SHA256) |
| Linear access and refresh tokens | `OAUTH_TOKEN_STORE_PATH` (mode 0600) | All Linear API calls, as the app (`actor=app`) |
| `INGRESS_RECOVERY_KEY` | `.env` | Encrypting accepted-but-undispatched prompts on disk |
| `ANTHROPIC_API_KEY` or a Claude Code login | `.env` or the service account's home | Claude runs |
| Codex login | the service account's `~/.codex` | Codex runs |

The bridge requests the Linear scopes `read,write,app:assignable,app:mentionable`
with `actor=app`, so the app can be assigned and mentioned, and everything it
posts appears under the app's own name. `write` is needed to post agent
activities; with autonomous goals enabled it also moves a finished issue to the
team's completed state.

The agent itself runs with permissions bypassed, as the service account, in
`KB_PATH`. Anything that account can read, write, or reach over the network,
the agent can too, and anyone who can mention the agent in Linear directs it.
See [Security notes](docs/operations.md#security-notes) and
[Confining what the agent can write](docs/operations.md#confining-what-the-agent-can-write).

### Data flow

1. Linear sends an `AgentSessionEvent` webhook to your public `/webhook` URL
   when someone delegates an issue to the app, mentions it, or replies in its
   session. The payload includes the prompt and issue context.
2. The bridge verifies the signature and stores a receipt, plus an encrypted
   copy of the prompt until dispatch, under `data/` on your machine.
3. The selected runtime works in `KB_PATH` on your machine. For Claude, the
   prompt, issue context, and whatever files and tool output the agent reads
   are sent to the Anthropic API. For Codex, they go to OpenAI. Any MCP
   servers configured for the service account receive what the agent sends
   them.
4. The bridge posts the agent's thoughts, tool-call summaries (inputs
   truncated to 200 characters, failures to 500), and final response back to
   the Linear session through the Linear GraphQL API.

The bridge process sends no telemetry and contacts only Linear. The agent is
different: it runs as the service account with permissions bypassed, so it can
reach anything that account can, including the web and any tool it chooses to
run. Session transcripts and runtime state are kept by the runtime under the
service account's home directory (`~/.claude/` or `~/.codex/`), not in
`KB_PATH`.

## Engines

An engine is an `AgentRuntime`: the adapter between the bridge and whatever
does the work. [AGENTS.md](AGENTS.md) is written for a coding agent to add one:
the contract, the invariants it must not break, and a conformance suite
(`npm run test:engine -- <harness>`) that proves the engine correct.
[examples/http-job-engine](examples/http-job-engine) is a reference engine for
work that runs in another system.

## Support

This project is maintained on a best-effort basis. Open a
[GitHub issue](../../issues) for bugs and questions. Include the bridge
version, platform, runtime, and the relevant `[linear-agent-bridge]` log lines.
The logs are designed to contain no secrets, prompts, or issue text, but check
before you paste. Report security problems privately through GitHub's
**Report a vulnerability** button rather than a public issue.

## License

MIT
