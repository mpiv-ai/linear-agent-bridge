import { randomUUID } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import * as path from "node:path";
import { discardResponseBody, type FetchFn } from "./client.js";
import type { LinearCredentialProvider } from "./oauth.js";
import { syncDirectory } from "../delegation-store.js";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

/**
 * The exact scope string for every client-credentials request. Linear
 * revokes all of an app's `app` actor tokens when a request asks for
 * different scopes, so this must never vary between requests or processes.
 * https://linear.app/developers/oauth-2-0-authentication
 */
export const CLIENT_CREDENTIALS_SCOPE = "read,write,app:assignable,app:mentionable";

/** Renew this long before expiry; the grant's tokens last 30 days. */
const DEFAULT_RENEW_BEFORE_MS = 5 * 24 * 60 * 60 * 1000;

interface StoredClientCredentialsToken {
  accessToken: string;
  expiresAt: string;
  scope: string;
}

/** After a failed early renewal, wait this long before trying again. */
const DEFAULT_RENEW_BACKOFF_MS = 15 * 60 * 1000;

export interface ClientCredentialsTokenManagerOptions {
  clientId: string;
  clientSecret: string;
  /**
   * Where the service persists its token. Unset keeps the token in memory
   * only.
   */
  storePath?: string | undefined;
  renewBackoffMs?: number;
  fetchFn?: FetchFn;
  renewBeforeMs?: number;
  now?: () => number;
}

/**
 * Owns a client-credentials app's token.
 *
 * The grant returns an `app` actor token valid for 30 days with no refresh
 * token. It is renewed before expiry and after a 401, persisted atomically
 * per app, and fetched at most once at a time. Linear allows many parallel
 * tokens with the same scopes, so a token minted by another process never
 * invalidates this one.
 */
export class ClientCredentialsTokenManager implements LinearCredentialProvider {
  private token: StoredClientCredentialsToken | undefined;
  private loaded = false;
  private fetching: Promise<string> | undefined;
  private renewalNotBefore = 0;
  private readonly fetchFn: FetchFn;
  private readonly renewBeforeMs: number;
  private readonly renewBackoffMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ClientCredentialsTokenManagerOptions) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.renewBeforeMs = options.renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS;
    this.renewBackoffMs = options.renewBackoffMs ?? DEFAULT_RENEW_BACKOFF_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Load the persisted token. A missing, corrupt, or otherwise unusable file
   * is treated as no token, since a fresh one can always be minted; only a
   * permission error is fatal, because minting would not fix it.
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const storePath = this.options.storePath;
    if (storePath !== undefined) {
      try {
        const stored = JSON.parse(
          await fsPromises.readFile(storePath, "utf8"),
        ) as Partial<StoredClientCredentialsToken>;
        if (
          typeof stored.accessToken === "string" &&
          typeof stored.expiresAt === "string" &&
          Number.isFinite(Date.parse(stored.expiresAt)) &&
          stored.scope === CLIENT_CREDENTIALS_SCOPE
        ) {
          this.token = stored as StoredClientCredentialsToken;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") {
          throw new Error("Linear client-credentials token store is not readable");
        }
        if (code !== "ENOENT") {
          console.warn(
            "[linear-agent-bridge] client-credentials token store unusable; minting a new token",
          );
        }
      }
    }
    this.loaded = true;
  }

  /**
   * Never waits on a renewal while the current token is valid: inside the
   * renewal window the new token is fetched in the background, with backoff
   * after a failure. Only a missing or expired token is fetched inline.
   */
  async getAccessToken(signal?: AbortSignal): Promise<string> {
    await this.load();
    signal?.throwIfAborted();
    const current = this.token;
    if (current !== undefined) {
      const remaining = Date.parse(current.expiresAt) - this.now();
      if (remaining > 0) {
        if (remaining <= this.renewBeforeMs) {
          this.renewInBackground();
        }
        return current.accessToken;
      }
    }
    return await this.fetchToken();
  }

  private renewInBackground(): void {
    if (this.fetching !== undefined || this.now() < this.renewalNotBefore) {
      return;
    }
    void this.fetchToken().catch((error: unknown) => {
      this.renewalNotBefore = this.now() + this.renewBackoffMs;
      console.error(
        `[linear-agent-bridge] client-credentials renewal failed; keeping the current token: error=${error instanceof Error ? error.name : "UnknownError"}`,
      );
    });
  }

  async refreshAfterUnauthorized(
    failedAccessToken: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.load();
    signal?.throwIfAborted();
    if (this.token !== undefined && this.token.accessToken !== failedAccessToken) {
      return this.token.accessToken;
    }
    return await this.fetchToken();
  }

  async needsAuthorization(): Promise<boolean> {
    return false;
  }

  async install(): Promise<void> {
    throw new Error(
      "Client-credentials apps have no authorization callback; their token comes from the client_credentials grant",
    );
  }

  private fetchToken(): Promise<string> {
    this.fetching ??= this.requestToken().finally(() => {
      this.fetching = undefined;
    });
    return this.fetching;
  }

  private async requestToken(): Promise<string> {
    const response = await this.fetchFn(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${this.options.clientId}:${this.options.clientSecret}`,
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: CLIENT_CREDENTIALS_SCOPE,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(
        `Linear client-credentials token request failed: ${response.status} ${response.statusText}`,
      );
    }
    const json = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof json.access_token !== "string" || json.access_token === "") {
      throw new Error("Linear client-credentials response missing access_token");
    }
    if (
      typeof json.expires_in !== "number" ||
      !Number.isFinite(json.expires_in) ||
      json.expires_in <= 0
    ) {
      throw new Error("Linear client-credentials response missing valid expires_in");
    }
    const token: StoredClientCredentialsToken = {
      accessToken: json.access_token,
      expiresAt: new Date(this.now() + json.expires_in * 1000).toISOString(),
      scope: CLIENT_CREDENTIALS_SCOPE,
    };
    await this.persist(token);
    this.token = token;
    return token.accessToken;
  }

  private async persist(token: StoredClientCredentialsToken): Promise<void> {
    const storePath = this.options.storePath;
    if (storePath === undefined) {
      return;
    }
    const directory = path.dirname(storePath);
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${storePath}.${randomUUID()}.tmp`;
    try {
      const handle = await fsPromises.open(tempPath, "w", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(token, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsPromises.rename(tempPath, storePath);
      await syncDirectory(directory);
    } finally {
      await fsPromises.rm(tempPath, { force: true });
    }
  }
}
