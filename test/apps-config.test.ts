import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { loadAppsConfig, parseAppsConfig } from "../src/apps-config.js";

const APP_USER_ID = "3f0c3c55-7a4e-4f8e-9d3b-2b1a2c3d4e5f";

const LEGACY_ENV = {
  LINEAR_CLIENT_ID: "default-client",
  LINEAR_CLIENT_SECRET: "default-client-secret",
  LINEAR_WEBHOOK_SECRET: "default-webhook-secret",
  INGRESS_RECOVERY_KEY: "A".repeat(43),
  AUTONOMOUS_GOAL_LABEL_ID: "0f8b8c3a-1d2e-4f5a-9b6c-7d8e9f0a1b2c",
  LINEAR_ACCESS_TOKEN: "default-bootstrap-token",
};

let dir: string;
let base: Config;

function secretFile(name: string, value: string, mode = 0o600): string {
  const file = path.join(dir, name);
  writeFileSync(file, `${value}\n`);
  chmodSync(file, mode);
  return file;
}

function builderApp(overrides: Record<string, unknown> = {}) {
  return {
    id: "builder",
    clientId: "builder-client",
    clientSecretFile: secretFile("builder-client-secret", "builder-client-secret-value"),
    webhookSecretFile: secretFile("builder-webhook-secret", "builder-webhook-secret-value"),
    appUserId: APP_USER_ID,
    target: "codex",
    stateDir: path.join(dir, "apps", "builder"),
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "apps-config-test-"));
  base = loadConfig({ ...LEGACY_ENV });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("legacy single-app configuration", () => {
  it("adds no apps when BRIDGE_APPS_FILE is unset, leaving the env app unchanged", () => {
    expect(loadAppsConfig(base, { ...LEGACY_ENV })).toEqual({ apps: [] });
    expect(base.runtime).toBe("claude");
    expect(base.appId).toBeUndefined();
  });
});

describe("BRIDGE_APPS_FILE", () => {
  it("derives an isolated config per app from file- and env-referenced secrets", () => {
    const file = path.join(dir, "apps.json");
    writeFileSync(
      file,
      JSON.stringify({
        apps: [
          builderApp(),
          {
            id: "research-desk",
            clientId: "research-client",
            clientSecretEnv: "RESEARCH_CLIENT_SECRET",
            webhookSecretEnv: "RESEARCH_WEBHOOK_SECRET",
            target: "codex",
            stateDir: path.join(dir, "apps", "research-desk"),
          },
        ],
      }),
    );
    const parsed = loadAppsConfig(base, {
      ...LEGACY_ENV,
      BRIDGE_APPS_FILE: file,
      RESEARCH_CLIENT_SECRET: "research-client-secret-value",
      RESEARCH_WEBHOOK_SECRET: "research-webhook-secret-value",
    });

    const [builder, research] = parsed.apps;
    expect(builder).toMatchObject({
      id: "builder",
      appUserId: APP_USER_ID,
      target: { kind: "codex" },
    });
    expect(builder!.config).toMatchObject({
      appId: "builder",
      runtime: "codex",
      linearClientId: "builder-client",
      linearClientSecret: "builder-client-secret-value",
      linearWebhookSecret: "builder-webhook-secret-value",
      oauthRedirectUri: base.oauthRedirectUri,
      port: base.port,
      ingressRecoveryKey: base.ingressRecoveryKey,
      sessionStorePath: path.join(dir, "apps", "builder", "sessions.json"),
      bridgeStateStorePath: path.join(dir, "apps", "builder", "bridge-state.json"),
      oauthTokenStorePath: path.join(dir, "apps", "builder", "oauth-tokens.json"),
    });
    // Bootstrap tokens and the bridge-side goal loop never leak across apps.
    expect(builder!.config.linearAccessToken).toBeUndefined();
    expect(builder!.config.autonomousGoalLabelId).toBeUndefined();
    expect(research!.config).toMatchObject({
      runtime: "codex",
      linearClientSecret: "research-client-secret-value",
      linearWebhookSecret: "research-webhook-secret-value",
    });
  });

  it.each(["clientSecret", "webhookSecret", "accessToken", "apiKey"])(
    "refuses an inline %s",
    (key) => {
      expect(() =>
        parseAppsConfig({ apps: [builderApp({ [key]: "inline" })] }, base, {}),
      ).toThrow(`secrets must be referenced with ${key}File or ${key}Env`);
    },
  );

  it("refuses a world-readable secret file without echoing its content", () => {
    const leaky = secretFile("leaky", "super-secret-value", 0o644);
    let message = "";
    try {
      parseAppsConfig({ apps: [builderApp({ clientSecretFile: leaky })] }, base, {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("must not be world-readable");
    expect(message).not.toContain("super-secret-value");
  });

  it("refuses a webhook secret shared with another app, because routing is by signature", () => {
    const shared = secretFile("shared", LEGACY_ENV.LINEAR_WEBHOOK_SECRET);
    expect(() =>
      parseAppsConfig(
        { apps: [builderApp({ webhookSecretFile: shared })] },
        base,
        {},
      ),
    ).toThrow("each app needs its own webhook signing secret");
  });

  it("refuses duplicate ids, the reserved default id, and shared state", () => {
    expect(() =>
      parseAppsConfig({ apps: [builderApp({ id: "default" })] }, base, {}),
    ).toThrow("unique lowercase slug");
    const second = {
      ...builderApp(),
      clientId: "other-client",
      webhookSecretFile: secretFile("other-webhook", "other-webhook-secret"),
    };
    expect(() =>
      parseAppsConfig({ apps: [builderApp(), second] }, base, {}),
    ).toThrow("unique lowercase slug");
    expect(() =>
      parseAppsConfig(
        { apps: [builderApp(), { ...second, id: "writer" }] },
        base,
        {},
      ),
    ).toThrow("state paths must not be shared");
  });

  it("rejects an unknown target and a relative state directory", () => {
    expect(() =>
      parseAppsConfig({ apps: [builderApp({ target: "openclaw:agent" })] }, base, {}),
    ).toThrow('expected "claude" or "codex"');
    expect(() =>
      parseAppsConfig({ apps: [builderApp({ stateDir: "relative/dir" })] }, base, {}),
    ).toThrow("stateDir: expected an absolute path");
  });

  it("gives an app its own working directory and output folder, defaulting to the base config's", () => {
    const kbPath = path.join(dir, "research-notes");
    const agentOutputPath = path.join(dir, "research-output");
    const [own, inherited] = parseAppsConfig(
      {
        apps: [
          builderApp({ kbPath, agentOutputPath }),
          {
            ...builderApp({
              id: "writer",
              clientId: "writer-client",
              stateDir: path.join(dir, "apps", "writer"),
            }),
            clientSecretFile: secretFile("writer-client-secret", "writer-client-secret-value"),
            webhookSecretFile: secretFile("writer-webhook-secret", "writer-webhook-secret-value"),
          },
        ],
      },
      { ...base, kbPath: "/srv/default-kb", agentOutputPath: "/srv/default-output" },
      {},
    ).apps;

    expect(own!.config).toMatchObject({ kbPath, agentOutputPath });
    expect(inherited!.config).toMatchObject({
      kbPath: "/srv/default-kb",
      agentOutputPath: "/srv/default-output",
    });
  });

  it("rejects a relative working directory or output folder", () => {
    expect(() =>
      parseAppsConfig({ apps: [builderApp({ kbPath: "notes" })] }, base, {}),
    ).toThrow("kbPath: expected an absolute path");
    expect(() =>
      parseAppsConfig({ apps: [builderApp({ agentOutputPath: "out" })] }, base, {}),
    ).toThrow("agentOutputPath: expected an absolute path");
  });

  it("requires an apps array", () => {
    for (const raw of [{}, { apps: {} }, [], null]) {
      expect(() => parseAppsConfig(raw, base, {})).toThrow(
        'Invalid BRIDGE_APPS_FILE: expected an object with an "apps" array',
      );
    }
  });

  it("names a missing env-referenced secret without a value", () => {
    expect(() =>
      parseAppsConfig(
        {
          apps: [
            builderApp({
              target: "claude",
              clientSecretFile: undefined,
              clientSecretEnv: "MISSING_SECRET",
            }),
          ],
        },
        base,
        {},
      ),
    ).toThrow("environment variable MISSING_SECRET is not set");
  });
});

describe("client-credentials apps", () => {
  it("builds a client-credentials app that leaves the app user to viewer { id } when appUserId is omitted", () => {
    const parsed = parseAppsConfig(
      {
        apps: [
          builderApp({
            auth: "client_credentials",
            appUserId: undefined,
            target: "claude",
          }),
        ],
      },
      base,
      {},
    );
    expect(parsed.apps).toHaveLength(1);
    expect(parsed.apps[0]!.appUserId).toBeUndefined();
    expect(parsed.apps[0]!.config).toMatchObject({
      appId: "builder",
      linearAuth: "client_credentials",
      runtime: "claude",
      oauthTokenStorePath: path.join(dir, "apps", "builder", "oauth-tokens.json"),
      delegationStorePath: path.join(dir, "apps", "builder", "delegations.json"),
    });
    expect(parsed.apps[0]!.config.appUserId).toBeUndefined();
    // The default app keeps the authorization-code flow.
    expect(base.linearAuth).toBeUndefined();
  });

  it("carries the configured app user id onto the app and its config", () => {
    const parsed = parseAppsConfig(
      { apps: [builderApp({ auth: "client_credentials" })] },
      base,
      {},
    );
    expect(parsed.apps[0]).toMatchObject({
      appUserId: APP_USER_ID,
      config: { appUserId: APP_USER_ID, linearAuth: "client_credentials" },
    });
  });

  it("refuses a group-writable secret file referenced directly", () => {
    const writable = secretFile("writable-secret", "value", 0o660);
    expect(() =>
      parseAppsConfig({ apps: [builderApp({ clientSecretFile: writable })] }, base, {}),
    ).toThrow("clientSecretFile: must not be group- or world-writable");
  });

  it("rejects an unknown auth value", () => {
    expect(() =>
      parseAppsConfig({ apps: [builderApp({ auth: "password" })] }, base, {}),
    ).toThrow('expected "authorization_code" or "client_credentials"');
  });

  it("accepts a secret file whose group read bit comes from an ACL grant", () => {
    const grouped = secretFile("group-readable", "group-readable-value", 0o640);
    const parsed = parseAppsConfig(
      { apps: [builderApp({ clientSecretFile: grouped })] },
      base,
      {},
    );
    expect(parsed.apps.map((app) => app.id)).toEqual(["builder"]);
  });

  it("fails the whole config when one app cannot be configured, naming the app and never a secret", () => {
    const leaky = secretFile("leaky-secret", "leaky-secret-value", 0o644);
    let message = "";
    try {
      parseAppsConfig(
        {
          apps: [
            builderApp({ id: "first", auth: "client_credentials" }),
            {
              ...builderApp({ id: "second", clientSecretFile: leaky }),
              clientId: "second-client",
              webhookSecretFile: secretFile("second-webhook", "second-webhook-value"),
              stateDir: path.join(dir, "apps", "second"),
            },
          ],
        },
        base,
        {},
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("apps[1]");
    expect(message).toContain("must not be world-readable");
    expect(message).not.toContain("leaky-secret-value");
  });
});
