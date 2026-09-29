import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonDelegationStore, delegationKey } from "../src/delegation-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-store-test-"));
  file = path.join(dir, "delegations.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const delegation = { issueId: "issue-1", delegationId: "history-1", delegatedAt: "2026-09-24T12:00:00.000Z" };

describe("JsonDelegationStore", () => {
  it("keeps the first recorded intent of a delegation across instances", async () => {
    const key = delegationKey("issue-1", "history-1");
    let now = Date.parse("2026-09-24T12:05:00.000Z");
    const first = await new JsonDelegationStore(file, () => now).recordIntent(key, delegation);
    now += 60_000;
    const second = await new JsonDelegationStore(file, () => now).recordIntent(key, delegation);
    expect(first.intentAt).toBe("2026-09-24T12:05:00.000Z");
    expect(second.intentAt).toBe("2026-09-24T12:05:00.000Z");
    await expect(new JsonDelegationStore(file).get(key)).resolves.toMatchObject({
      ...delegation,
      intentAt: "2026-09-24T12:05:00.000Z",
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  // Round 2, finding 5: a corrupt store self-heals instead of stopping the app.
  it.each([
    ["truncated JSON", '{"issue-1:history-1": {"intent'],
    ["an array", "[]"],
  ])("moves a store holding %s aside and starts fresh", async (_label, content) => {
    await fs.writeFile(file, content);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const store = new JsonDelegationStore(file);
      await expect(store.get("anything")).resolves.toBeUndefined();
      await expect(
        store.recordIntent(delegationKey("issue-1", "history-1"), delegation),
      ).resolves.toMatchObject(delegation);
      expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining("delegation store was corrupt; moved aside"),
      ]);
    } finally {
      errors.mockRestore();
    }
    const entries = await fs.readdir(dir);
    const quarantined = entries.filter((entry) => entry.startsWith("delegations.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, quarantined[0]!), "utf8")).toBe(content);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
      "issue-1:history-1": { ...delegation, intentAt: expect.any(String) },
    });
  });
});
