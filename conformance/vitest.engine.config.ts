import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["conformance/external.engine.ts"],
    // The bridge logs every lifecycle step; keep the scenario results readable.
    // Failures still print their assertion and stack.
    silent: true,
  },
});
