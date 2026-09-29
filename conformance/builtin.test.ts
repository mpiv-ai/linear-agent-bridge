// Runs the engine conformance suite against every engine in this
// repository. `npm run test:engine -- <module>` runs it against one more.

import { runEngineConformance } from "./suite.js";
import claude from "./engines/claude.js";
import codex from "./engines/codex.js";

runEngineConformance(claude);
runEngineConformance(codex);
