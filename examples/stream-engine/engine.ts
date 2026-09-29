// The smallest useful engine: it adapts an in-process streaming backend to
// the bridge's AgentRuntime contract. Start here when your backend is a
// library or client that streams events for one conversation turn.

import { withLinearAgentSessionContext } from "../../src/runtime/prompt.js";
import type { AgentRuntime, RuntimeEvent, SessionRequest } from "../../src/types.js";

/** What the backend streams for one turn. */
export type StreamEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string; final: boolean }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; output: string };

/** The backend: start or continue a conversation and stream one turn. */
export interface StreamBackend {
  run(input: { prompt: string; sessionId?: string | undefined; signal: AbortSignal }): AsyncIterable<StreamEvent>;
}

export class StreamRuntime implements AgentRuntime {
  readonly name = "stream";

  constructor(private readonly backend: StreamBackend) {}

  async *runSession(request: SessionRequest): AsyncIterable<RuntimeEvent> {
    const signal = request.abortController?.signal ?? new AbortController().signal;
    const openCalls = new Map<string, { action: string; parameter: string }>();
    try {
      const stream = this.backend.run({
        // Tells the agent it is inside a Linear session whose final
        // response the bridge posts for it.
        prompt: withLinearAgentSessionContext(request.prompt),
        sessionId: request.resumeSessionId,
        signal,
      });
      for await (const event of stream) {
        // Every backend event proves the turn is alive and resets the
        // bridge's inactivity watchdog.
        yield { kind: "progress" };
        if (signal.aborted) {
          break;
        }
        switch (event.type) {
          case "session":
            yield { kind: "session-started", runtimeSessionId: event.id };
            break;
          case "text":
            yield {
              kind: "activity",
              activity: { type: event.final ? "response" : "thought", body: event.text },
            };
            break;
          case "tool_call": {
            const card = { action: event.name, parameter: JSON.stringify(event.input).slice(0, 200) };
            openCalls.set(event.callId, card);
            yield { kind: "activity", activity: { type: "action", ...card } };
            break;
          }
          case "tool_result": {
            // Close the card with the same action and parameter it opened with.
            const card = openCalls.get(event.callId);
            if (card !== undefined) {
              openCalls.delete(event.callId);
              yield { kind: "activity", activity: { type: "action", ...card, result: event.output.slice(0, 500) } };
            }
            break;
          }
        }
      }
    } catch (error) {
      // A throw after an abort is the backend acknowledging the cancel.
      if (!signal.aborted) {
        throw error;
      }
    }
    yield { kind: "done" };
  }
}
