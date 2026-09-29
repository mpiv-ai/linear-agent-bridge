// Conformance harness for ClaudeRuntime: plays each script as the Agent
// SDK's message stream through the runtime's injectable `query()`.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntime, type QueryFn } from "../../src/runtime/claude.js";
import { defineEngine, ScriptedBackend, type PlayableStep } from "../kit.js";

function message(sessionId: string, value: Record<string, unknown>): SDKMessage {
  return { uuid: "00000000-0000-0000-0000-000000000000", session_id: sessionId, ...value } as unknown as SDKMessage;
}

function assistant(
  sessionId: string,
  content: Array<Record<string, unknown>>,
  stopReason: string | null,
): SDKMessage {
  return message(sessionId, {
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: "msg", type: "message", role: "assistant", content, stop_reason: stopReason, stop_sequence: null, usage: {} },
  });
}

function* translate(sessionId: string, step: PlayableStep, toolIndex: number): Generator<SDKMessage> {
  switch (step.type) {
    case "thought":
      yield assistant(sessionId, [{ type: "text", text: step.text }], null);
      return;
    case "tool": {
      const id = `tool_${toolIndex}`;
      yield assistant(sessionId, [{ type: "tool_use", id, name: step.name, input: step.input }], "tool_use");
      yield message(sessionId, {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: step.output, is_error: false }] },
      });
      return;
    }
    case "response":
      yield assistant(sessionId, [{ type: "text", text: step.text }], "end_turn");
      yield message(sessionId, { type: "result", subtype: "success", is_error: false, num_turns: 1, result: step.text, usage: {}, modelUsage: {}, permission_denials: [] });
      return;
    case "throw":
      throw new Error(step.message);
  }
}

export default defineEngine({
  name: "claude",
  createHarness() {
    const backend = new ScriptedBackend();
    const queryFn: QueryFn = ({ prompt, options }) => {
      const turn = backend.startTurn({ prompt, resumeSessionId: options?.resume });
      options?.abortController?.signal.addEventListener("abort", () => turn.cancel(), { once: true });
      const stream = (async function* (): AsyncGenerator<SDKMessage> {
        yield message(turn.record.sessionId, { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY", cwd: "/tmp/conformance-kb", tools: [], model: "conformance" });
        let toolIndex = 0;
        for await (const step of turn.steps()) {
          yield* translate(turn.record.sessionId, step, toolIndex++);
        }
      })();
      return Object.assign(stream, { close: () => turn.cancel() });
    };
    return { runtime: new ClaudeRuntime("/tmp/conformance-kb", queryFn), backend };
  },
});
