import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CREDENTIALS_SCOPE,
  ClientCredentialsTokenManager,
} from "../src/linear/client-credentials.js";
import type { FetchFn } from "../src/linear/client.js";

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let storePath: string;
let clock: number;

interface TokenRequest {
  authorization: string | null;
  body: URLSearchParams;
}

function tokenEndpoint(
  requests: TokenRequest[],
  responses: Array<Response | (() => Response)>,
): FetchFn {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      body: new URLSearchParams(String(init?.body)),
    });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("unexpected token request");
    }
    return typeof next === "function" ? next() : next;
  }) as FetchFn;
}

function granted(token: string, expiresInSeconds = 30 * 24 * 60 * 60): Response {
  return Response.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: expiresInSeconds,
    scope: CLIENT_CREDENTIALS_SCOPE,
  });
}

function manager(fetchFn: FetchFn): ClientCredentialsTokenManager {
  return new ClientCredentialsTokenManager({
    clientId: "builder-client",
    clientSecret: "builder-secret",
    storePath,
    fetchFn,
    now: () => clock,
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "client-credentials-test-"));
  storePath = path.join(dir, "apps", "builder", "oauth-tokens.json");
  clock = Date.parse("2026-09-24T12:00:00.000Z");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function eventually(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("condition not met within 2s");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ClientCredentialsTokenManager", () => {
  it("requests the fixed scope with HTTP basic auth and persists the token atomically, owner-only", async () => {
    const requests: TokenRequest[] = [];
    const tokens = manager(tokenEndpoint(requests, [granted("cc-token-1")]));

    await expect(tokens.getAccessToken()).resolves.toBe("cc-token-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.authorization).toBe(
      `Basic ${Buffer.from("builder-client:builder-secret").toString("base64")}`,
    );
    expect(Object.fromEntries(requests[0]!.body)).toEqual({
      grant_type: "client_credentials",
      scope: "read,write,app:assignable,app:mentionable",
    });
    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored).toEqual({
      accessToken: "cc-token-1",
      expiresAt: new Date(clock + 30 * DAY).toISOString(),
      scope: CLIENT_CREDENTIALS_SCOPE,
    });
    expect((await fs.stat(storePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(storePath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reuses the stored token across restarts until the renewal window", async () => {
    await manager(tokenEndpoint([], [granted("cc-token-1")])).getAccessToken();
    const requests: TokenRequest[] = [];
    clock += 20 * DAY;
    const restarted = manager(tokenEndpoint(requests, []));
    await expect(restarted.getAccessToken()).resolves.toBe("cc-token-1");
    expect(requests).toHaveLength(0);
  });

  // Finding 5: renewal never blocks a caller while the token is valid.
  it("renews in the background inside the window, answering with the valid token at once", async () => {
    await manager(tokenEndpoint([], [granted("cc-token-1")])).getAccessToken();
    clock += 26 * DAY;
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: TokenRequest[] = [];
    // A token endpoint that hangs until released.
    const renewing = manager((async () => {
      requests.push({ authorization: null, body: new URLSearchParams() });
      await hanging;
      return granted("cc-token-2");
    }) as FetchFn);

    // Both calls resolve while the token endpoint is still hanging.
    await expect(renewing.getAccessToken()).resolves.toBe("cc-token-1");
    await expect(renewing.getAccessToken()).resolves.toBe("cc-token-1");
    expect(requests).toHaveLength(1);
    release();
    await eventually(async () => (await renewing.getAccessToken()) === "cc-token-2");
    expect(JSON.parse(await fs.readFile(storePath, "utf8")).accessToken).toBe("cc-token-2");
  });

  it("backs off after a failed background renewal and keeps serving the valid token", async () => {
    await manager(tokenEndpoint([], [granted("cc-token-1")])).getAccessToken();
    clock += 26 * DAY;
    const requests: TokenRequest[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failing = new ClientCredentialsTokenManager({
        clientId: "builder-client",
        clientSecret: "builder-secret",
        storePath,
        fetchFn: tokenEndpoint(requests, [
          new Response("unavailable", { status: 503 }),
          granted("cc-token-2"),
        ]),
        renewBackoffMs: 60_000,
        now: () => clock,
      });
      await expect(failing.getAccessToken()).resolves.toBe("cc-token-1");
      await eventually(() => errorSpy.mock.calls.length === 1);
      await expect(failing.getAccessToken()).resolves.toBe("cc-token-1");
      expect(requests).toHaveLength(1);
      clock += 61_000;
      await expect(failing.getAccessToken()).resolves.toBe("cc-token-1");
      expect(requests).toHaveLength(2);
      await eventually(async () => (await failing.getAccessToken()) === "cc-token-2");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fetches inline only once the token has expired", async () => {
    await manager(tokenEndpoint([], [granted("cc-token-1")])).getAccessToken();
    clock += 31 * DAY;
    await expect(manager(tokenEndpoint([], [granted("cc-token-2")])).getAccessToken()).resolves.toBe("cc-token-2");
  });

  // Finding 4: a corrupt store never blocks startup.
  it.each([
    ["truncated JSON", "{\"accessToken\": \"cc-tok"],
    ["a JSON array", "[]"],
    ["an unparseable expiry", JSON.stringify({ accessToken: "x", expiresAt: "soon", scope: CLIENT_CREDENTIALS_SCOPE })],
  ])("treats %s in the token store as missing and mints a new token", async (_label, content) => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, content);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const tokens = manager(tokenEndpoint([], [granted("cc-token-fresh")]));
      await tokens.load();
      await expect(tokens.getAccessToken()).resolves.toBe("cc-token-fresh");
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses an unreadable token store, because a new token would not fix it", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, "{}");
    await fs.chmod(storePath, 0o000);
    await expect(manager(tokenEndpoint([], [])).load()).rejects.toThrow(
      "token store is not readable",
    );
  });

  // Without a store path the token lives in memory only.
  it("persists nothing without a store path", async () => {
    const tokens = new ClientCredentialsTokenManager({
      clientId: "builder-client",
      clientSecret: "builder-secret",
      fetchFn: tokenEndpoint([], [granted("cc-memory")]),
      now: () => clock,
    });
    await expect(tokens.getAccessToken()).resolves.toBe("cc-memory");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("fetches a new token once after a 401, even for concurrent callers", async () => {
    const requests: TokenRequest[] = [];
    const tokens = manager(
      tokenEndpoint(requests, [granted("cc-token-1"), granted("cc-token-2")]),
    );
    const first = await tokens.getAccessToken();
    const [a, b] = await Promise.all([
      tokens.refreshAfterUnauthorized(first),
      tokens.refreshAfterUnauthorized(first),
    ]);
    expect([a, b]).toEqual(["cc-token-2", "cc-token-2"]);
    expect(requests).toHaveLength(2);
    // A caller holding the already-replaced token gets the new one for free.
    await expect(tokens.refreshAfterUnauthorized(first)).resolves.toBe("cc-token-2");
    expect(requests).toHaveLength(2);
  });

  it("ignores a stored token minted with other scopes instead of reusing it", async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify({
        accessToken: "old-scope-token",
        expiresAt: new Date(clock + 20 * DAY).toISOString(),
        scope: "read",
      }),
    );
    const tokens = manager(tokenEndpoint([], [granted("cc-token-1")]));
    await expect(tokens.getAccessToken()).resolves.toBe("cc-token-1");
  });

  it("never asks for an authorization URL or accepts a callback", async () => {
    const tokens = manager(tokenEndpoint([], []));
    await expect(tokens.needsAuthorization()).resolves.toBe(false);
    await expect(tokens.install()).rejects.toThrow("no authorization callback");
  });

  it("reports a failed grant without echoing the response body", async () => {
    const tokens = manager(
      tokenEndpoint([], [new Response("client_secret=leaked", { status: 401, statusText: "Unauthorized" })]),
    );
    const error = await tokens.getAccessToken().catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      "Linear client-credentials token request failed: 401 Unauthorized",
    );
  });
});
