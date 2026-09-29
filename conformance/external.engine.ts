// Entry point for `npm run test:engine -- <module>`: runs the suite
// against the engine definition that module default-exports.

import { pathToFileURL } from "node:url";
import type { EngineDefinition } from "./kit.js";
import { runEngineConformance } from "./suite.js";

const modulePath = process.env.ENGINE_MODULE;
if (modulePath === undefined || modulePath === "") {
  throw new Error("Usage: npm run test:engine -- <path to an engine harness module>");
}
const loaded = (await import(pathToFileURL(modulePath).href)) as { default?: EngineDefinition };
if (typeof loaded.default?.createHarness !== "function") {
  throw new Error(`${modulePath} must default-export defineEngine({ name, createHarness })`);
}
runEngineConformance(loaded.default);
