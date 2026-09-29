// Conformance harness for CodexRuntime: plays each script as the Codex
// SDK's thread event stream through the runtime's injectable client.

import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexRuntime, type CodexClient, type CodexThread } from "../../src/runtime/codex.js";
import { defineEngine, ScriptedBackend, type PlayableStep } from "../kit.js";

function* translate(step: PlayableStep, index: number): Generator<ThreadEvent> {
  switch (step.type) {
    case "thought":
      yield { type: "item.completed", item: { id: `reasoning-${index}`, type: "reasoning", text: step.text } };
      return;
    case "tool": {
      const item = { id: `tool-${index}`, type: "mcp_tool_call", server: "conformance", tool: step.name, arguments: step.input } as const;
      yield { type: "item.started", item: { ...item, status: "in_progress" } };
      yield { type: "item.completed", item: { ...item, status: "completed" } };
      return;
    }
    case "response":
      yield { type: "item.completed", item: { id: `message-${index}`, type: "agent_message", text: step.text } };
      return;
    case "throw":
      throw new Error(step.message);
  }
}

export default defineEngine({
  name: "codex",
  createHarness() {
    const backend = new ScriptedBackend();
    const thread = (resumeSessionId: string | undefined): CodexThread => ({
      async runStreamed(input, options) {
        const turn = backend.startTurn({ prompt: input, resumeSessionId });
        options?.signal?.addEventListener("abort", () => turn.cancel(), { once: true });
        if (options?.signal?.aborted === true) {
          turn.cancel();
        }
        const events = (async function* (): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: turn.record.sessionId };
          yield { type: "turn.started" };
          let index = 0;
          let responded = false;
          for await (const step of turn.steps()) {
            responded ||= step.type === "response";
            yield* translate(step, index++);
          }
          if (responded && !turn.record.cancelled) {
            yield { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } };
          }
        })();
        return { events };
      },
    });
    const client: CodexClient = {
      startThread: () => thread(undefined),
      resumeThread: (id) => thread(id),
    };
    return { runtime: new CodexRuntime("/tmp/conformance-kb", async () => client), backend };
  },
});
