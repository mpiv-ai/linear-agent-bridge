// Engine conformance kit: the pieces an engine author implements to run
// the shared contract suite (conformance/suite.ts) against an AgentRuntime.
//
// The suite never talks to a real model or service. It describes each turn
// as a backend script, and the engine's harness plays that script through a
// fake of the engine's own backend (an SDK stream, a job API, ...). The
// suite then checks what the engine yields and what the bridge posts.

import type { AgentRuntime } from "../src/types.js";

/** One thing the fake backend does during a turn, in order. */
export type ScriptStep =
  /** Interim reasoning or narration; the engine should yield a thought. */
  | { type: "thought"; text: string }
  /**
   * A tool call that runs and finishes. The engine should yield an action
   * card without a result, then close it with the same action and
   * parameter plus a result.
   */
  | { type: "tool"; name: string; input: Record<string, unknown>; output: string }
  /** The final answer; the engine should yield exactly one response. */
  | { type: "response"; text: string }
  /** The backend fails mid-stream with this message. */
  | { type: "throw"; message: string }
  /** The backend goes silent until the engine cancels the turn. */
  | { type: "hang" }
  /**
   * The backend pauses until the suite calls `ScriptedBackend.release()`,
   * or ends if the engine cancels the turn first. Used for reattach.
   */
  | { type: "gate" };

/** A step the harness must translate; hang and gate are handled for it. */
export type PlayableStep = Extract<ScriptStep, { type: "thought" | "tool" | "response" | "throw" }>;

/** What the backend saw for one turn the engine started against it. */
export interface BackendTurn {
  readonly prompt: string;
  /** The session the engine asked to continue, or undefined for a fresh start. */
  readonly resumeSessionId: string | undefined;
  /** The backend's id for this conversation: the resumed id, or a new one. */
  readonly sessionId: string;
  /** Set once the engine cancelled this turn (abort, force-close, or stop). */
  cancelled: boolean;
  /** Set while the backend waits at a hang or gate step. */
  waiting: boolean;
  /** Set once every step played, or the turn ended early. */
  finished: boolean;
}

/** A turn in progress, handed to the harness when the engine starts one. */
export interface BackendTurnHandle {
  readonly record: BackendTurn;
  /**
   * The steps the harness must translate into backend events, in order.
   * Iteration ends early, without error, if the turn is cancelled while
   * hanging or gated.
   */
  steps(): AsyncIterable<PlayableStep>;
  /** Record that the engine cancelled this turn. Idempotent. */
  cancel(): void;
  /** Resolves once the turn is cancelled. */
  readonly cancelledPromise: Promise<void>;
}

/**
 * The scripted backend shared by every harness. The suite enqueues one
 * script per turn; the harness calls `startTurn` when the engine starts a
 * turn against its backend and translates the handle's steps.
 */
export class ScriptedBackend {
  readonly turns: BackendTurn[] = [];
  private readonly scripts: ScriptStep[][] = [];
  private nextSession = 1;
  private gate: { promise: Promise<void>; open: () => void } = openableGate();

  /** Queue the script played by the next turn the engine starts. */
  enqueue(steps: ScriptStep[]): void {
    this.scripts.push(steps);
  }

  /** Open the current gate step, and every later one. */
  release(): void {
    this.gate.open();
  }

  startTurn(input: { prompt: string; resumeSessionId?: string | undefined }): BackendTurnHandle {
    const steps = this.scripts.shift();
    if (steps === undefined) {
      throw new Error("conformance: the engine started a backend turn the suite did not script");
    }
    const record: BackendTurn = {
      prompt: input.prompt,
      resumeSessionId: input.resumeSessionId,
      sessionId: input.resumeSessionId ?? `backend-session-${this.nextSession++}`,
      cancelled: false,
      waiting: false,
      finished: false,
    };
    this.turns.push(record);
    let markCancelled!: () => void;
    const cancelledPromise = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const gate = this.gate;
    const cancelled = (): boolean => record.cancelled;
    return {
      record,
      cancelledPromise,
      cancel: () => {
        if (!record.cancelled) {
          record.cancelled = true;
          markCancelled();
        }
      },
      steps: async function* (): AsyncGenerator<PlayableStep> {
        try {
          for (const step of steps) {
            if (cancelled()) {
              return;
            }
            if (step.type === "hang") {
              record.waiting = true;
              await cancelledPromise;
              return;
            }
            if (step.type === "gate") {
              record.waiting = true;
              await Promise.race([gate.promise, cancelledPromise]);
              record.waiting = false;
              if (cancelled()) {
                return;
              }
              continue;
            }
            // Give the engine a real turn of the event loop between steps,
            // the way a network or subprocess stream would.
            await new Promise((resolve) => setImmediate(resolve));
            yield step;
          }
        } finally {
          record.waiting = false;
          record.finished = true;
        }
      },
    };
  }
}

function openableGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A runtime wired to a scripted fake of its backend. */
export interface EngineHarness {
  readonly runtime: AgentRuntime;
  readonly backend: ScriptedBackend;
  /** Release anything the harness started (servers, timers). */
  dispose?(): Promise<void> | void;
}

/** What an engine module default-exports for `npm run test:engine`. */
export interface EngineDefinition {
  readonly name: string;
  /** Build a fresh runtime and backend. Called once per scenario. */
  createHarness(): Promise<EngineHarness> | EngineHarness;
}

export function defineEngine(definition: EngineDefinition): EngineDefinition {
  return definition;
}
