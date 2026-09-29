import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface SessionRecord {
  linearSessionId: string;
  runtimeSessionId: string;
  runtime: string;
  issueIdentifier?: string | undefined;
  /** Linked external work owned by another session. */
  sharedWork?: boolean | undefined;
  /**
   * The Linear issue id (uuid) and delegating actor id a runtime opened
   * external work for, when the runtime asked to persist them, so a
   * follow-up after a restart can still recover the origin of that work.
   * Unset for every runtime and session-started event that does not ask.
   */
  issueId?: string | undefined;
  actorId?: string | undefined;
  updatedAt: string;
}

type SessionMap = Record<string, SessionRecord>;

/**
 * Maps Linear agent-session ids to runtime session ids so follow-up
 * prompts resume the same agent conversation. JSON file on disk;
 * writes are atomic (write temp, rename).
 */
export class JsonSessionStore {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(linearSessionId: string): Promise<SessionRecord | undefined> {
    const sessions = await this.readAll();
    return sessions[linearSessionId];
  }

  async put(record: SessionRecord): Promise<void> {
    const operation = this.pendingWrite.then(async () => {
      const sessions = await this.readAll();
      sessions[record.linearSessionId] = record;
      await this.writeAll(sessions);
    });
    this.pendingWrite = operation.catch(() => undefined);
    await operation;
  }

  async listSessionIds(): Promise<string[]> {
    return Object.keys(await this.readAll()).sort();
  }

  /** Missing file or unparseable content both read as an empty store. */
  private async readAll(): Promise<SessionMap> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, "utf8");
    } catch {
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as SessionMap;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Write temp file in the same dir, then rename — atomic on POSIX. */
  private async writeAll(sessions: SessionMap): Promise<void> {
    const dir = path.dirname(this.path);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = path.join(dir, `.${path.basename(this.path)}.${randomUUID()}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(sessions, null, 2), "utf8");
    await fs.rename(tmpPath, this.path);
  }
}
