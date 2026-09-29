// Conformance harness for StreamRuntime: a fake StreamBackend that plays
// the suite's script as StreamEvents.

import { defineEngine, ScriptedBackend } from "../../conformance/kit.js";
import { StreamRuntime, type StreamBackend, type StreamEvent } from "./engine.js";

export default defineEngine({
  name: "stream",
  createHarness() {
    const backend = new ScriptedBackend();
    const fake: StreamBackend = {
      async *run({ prompt, sessionId, signal }): AsyncGenerator<StreamEvent> {
        const turn = backend.startTurn({ prompt, resumeSessionId: sessionId });
        signal.addEventListener("abort", () => turn.cancel(), { once: true });
        yield { type: "session", id: turn.record.sessionId };
        let call = 0;
        for await (const step of turn.steps()) {
          switch (step.type) {
            case "thought":
              yield { type: "text", text: step.text, final: false };
              break;
            case "tool":
              call += 1;
              yield { type: "tool_call", callId: `call-${call}`, name: step.name, input: step.input };
              yield { type: "tool_result", callId: `call-${call}`, output: step.output };
              break;
            case "response":
              yield { type: "text", text: step.text, final: true };
              break;
            case "throw":
              throw new Error(step.message);
          }
        }
      },
    };
    return { runtime: new StreamRuntime(fake), backend };
  },
});
