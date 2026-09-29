import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * One delegation of one issue to one app, named by the Linear history entry
 * that set the delegate. The missing-session fallback records its
 * intent here before opening a session, so a crash between opening and
 * claiming it adopts that session instead of opening another.
 */
export interface DelegationRecord {
  issueId: string;
  delegationId: string;
  delegatedAt: string;
  /** The fallback recorded its intent before opening a session. */
  intentAt?: string | undefined;
  updatedAt: string;
}

type DelegationMap = Record<string, DelegationRecord>;

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function delegationKey(issueId: string, delegationId: string): string {
  return `${issueId}:${delegationId}`;
}

/**
 * JSON file per app, written atomically (fsync, then rename) and serialized
 * within the process. Only the service writes it.
 */
export class JsonDelegationStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<DelegationRecord | undefined> {
    await this.pending.catch(() => undefined);
    return (await this.readAll())[key];
  }

  /** Durably record that the fallback is about to open a session. */
  recordIntent(
    key: string,
    delegation: { issueId: string; delegationId: string; delegatedAt: string },
  ): Promise<DelegationRecord> {
    return this.mutate((records) => {
      const timestamp = new Date(this.now()).toISOString();
      const record = records[key] ?? { ...delegation, updatedAt: timestamp };
      record.intentAt ??= timestamp;
      record.updatedAt = timestamp;
      records[key] = record;
      return record;
    });
  }

  private mutate<T>(change: (records: DelegationMap) => T): Promise<T> {
    const operation = this.pending
      .catch(() => undefined)
      .then(async () => {
        const records = await this.readAll();
        const result = change(records);
        const cutoff = this.now() - RETENTION_MS;
        for (const [key, record] of Object.entries(records)) {
          if (Date.parse(record.updatedAt) < cutoff) {
            delete records[key];
          }
        }
        await this.writeAll(records);
        return result;
      });
    this.pending = operation;
    return operation;
  }

  /**
   * A corrupt file is moved aside (`<name>.corrupt-<time>`) and read as
   * empty, the way the token store self-heals: losing delegation records
   * costs at most a deduplicated relink, while refusing to read them would
   * stop the app.
   */
  private async readAll(): Promise<DelegationMap> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const quarantine = `${this.filePath}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`;
      await fs.rename(this.filePath, quarantine);
      await syncDirectory(path.dirname(this.filePath));
      console.error(
        `[linear-agent-bridge] delegation store was corrupt; moved aside: file=${path.basename(quarantine)}`,
      );
      return {};
    }
    return parsed as DelegationMap;
  }

  private async writeAll(records: DelegationMap): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const tempPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    try {
      const handle = await fs.open(tempPath, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(records, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, this.filePath);
      await syncDirectory(directory);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }
}

/** Make a rename durable: fsync the directory that holds the entry. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
