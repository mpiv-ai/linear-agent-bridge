#!/usr/bin/env node
// npm run test:engine -- <engine harness module>
// Runs the engine conformance suite (conformance/suite.ts) against the
// engine definition the module default-exports.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

const [target, ...vitestArgs] = process.argv.slice(2);
if (target === undefined) {
  console.error("Usage: npm run test:engine -- <engine harness module> [vitest args]");
  process.exit(2);
}
const modulePath = path.resolve(target);
if (!existsSync(modulePath)) {
  console.error(`No such module: ${modulePath}`);
  process.exit(2);
}
const result = spawnSync(
  "npx",
  ["vitest", "run", "--config", "conformance/vitest.engine.config.ts", ...vitestArgs],
  { stdio: "inherit", env: { ...process.env, ENGINE_MODULE: modulePath } },
);
process.exit(result.status ?? 1);
