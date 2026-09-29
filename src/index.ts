import { loadConfig, type Config } from "./config.js";
import { loadAppsConfig } from "./apps-config.js";
import { startServer, type AppServerDeps } from "./server.js";
import { LinearAgentClient } from "./linear/client.js";
import { LinearOAuthTokenManager } from "./linear/oauth.js";
import { ClientCredentialsTokenManager } from "./linear/client-credentials.js";
import { JsonSessionStore } from "./sessions/store.js";
import { JsonDelegationStore } from "./delegation-store.js";
import { JsonBridgeStateStore } from "./state/store.js";
import { createIngressRecoveryKeyring } from "./state/recovery-envelope.js";
import { SessionLanes } from "./queue.js";
import { awaitReadyOrShutdown, installGracefulShutdown } from "./shutdown.js";
import { ClaudeRuntime, claudeAuthNotice } from "./runtime/claude.js";
import { CodexRuntime } from "./runtime/codex.js";
import type { AgentRuntime } from "./types.js";

function buildRuntime(config: Config): AgentRuntime {
  return config.runtime === "claude"
    ? new ClaudeRuntime(config.kbPath, undefined, config.agentOutputPath)
    : new CodexRuntime(config.kbPath, undefined, config.agentOutputPath);
}

async function buildApp(config: Config): Promise<AppServerDeps> {
  const oauth =
    config.linearAuth === "client_credentials"
      ? new ClientCredentialsTokenManager({
          clientId: config.linearClientId,
          clientSecret: config.linearClientSecret,
          storePath: config.oauthTokenStorePath,
        })
      : new LinearOAuthTokenManager({
          clientId: config.linearClientId,
          clientSecret: config.linearClientSecret,
          ...(config.linearAccessToken !== undefined
            ? { initialAccessToken: config.linearAccessToken }
            : {}),
          storePath: config.oauthTokenStorePath,
        });
  await oauth.load();
  const linear = new LinearAgentClient(oauth);
  return {
    config,
    runtime: buildRuntime(config),
    linear,
    oauth,
    store: new JsonSessionStore(config.sessionStorePath),
    bridgeState: new JsonBridgeStateStore(config.bridgeStateStorePath, {
      recoveryKeyring: createIngressRecoveryKeyring(
        config.ingressRecoveryKey,
        config.ingressRecoveryPreviousKeys,
      ),
    }),
    queue: new SessionLanes(),
    ...(config.delegationStorePath !== undefined
      ? { delegations: new JsonDelegationStore(config.delegationStorePath) }
      : {}),
  };
}

const config = loadConfig();
const appsConfig = loadAppsConfig(config);
if (
  [config, ...appsConfig.apps.map((app) => app.config)].some(
    (appConfig) => appConfig.runtime === "claude",
  )
) {
  const notice = claudeAuthNotice(process.env);
  if (notice !== undefined) {
    console.warn(`[linear-agent-bridge] ${notice}`);
  }
}
const defaultApp = await buildApp(config);
// One additional app that cannot even be built stays down alone.
const additionalApps: AppServerDeps[] = [];
for (const app of appsConfig.apps) {
  try {
    additionalApps.push(await buildApp(app.config));
  } catch (error) {
    console.error(
      `[linear-agent-bridge] app unavailable: app=${app.id} error=${error instanceof Error ? error.message : "UnknownError"}`,
    );
  }
}
const server = startServer({
  ...defaultApp,
  ...(additionalApps.length > 0 ? { additionalApps } : {}),
});
const shutdown = installGracefulShutdown(server, {
  timeoutMs: config.shutdownTimeoutMs,
});
if (await awaitReadyOrShutdown(server.ready, shutdown)) {
  const appSummary = appsConfig.apps
    .map((app) => `${app.id}=${app.config.runtime}`)
    .join(",");
  console.log(
    `linear-agent-bridge listening on :${config.port} (runtime: ${config.runtime}${appSummary === "" ? "" : `; apps: ${appSummary}`})`,
  );
}
