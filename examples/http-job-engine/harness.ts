// Conformance harness: the runtime talks real HTTP to the fake job server.
// Run it with: npm run test:engine -- examples/http-job-engine/harness.ts

import { defineEngine, ScriptedBackend } from "../../conformance/kit.js";
import { HttpJobRuntime } from "./engine.js";
import { startFakeJobServer } from "./fake-server.js";

export default defineEngine({
  name: "http-job",
  async createHarness() {
    const backend = new ScriptedBackend();
    const server = await startFakeJobServer(backend);
    const runtime = new HttpJobRuntime({ baseUrl: server.url, pollIntervalMs: 10 });
    return { runtime, backend, dispose: () => server.close() };
  },
});
