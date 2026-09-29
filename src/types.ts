// Core domain types for the Linear <-> agent-runtime bridge.

interface LinearAgentSessionEventBase {
  /** Linear webhook configuration id; the Linear-Delivery header identifies a delivery. */
  webhookId: string;
  agentSession: {
    id: string;
    issue?: { id: string; identifier: string; title: string } | undefined;
    comment?: { id: string; body: string } | undefined;
    /**
     * The Linear user or app-actor who created or delegated this session
     * ("who may trigger"). Named `creator` per Linear's Agent
     * API docs (https://linear.app/developers/agents); not yet verified
     * against a live payload the way the other fields in this file are —
     * confirm the field name live before relying on it in production.
     */
    creator?: { id: string } | undefined;
  };
  /** Formatted context string on `created` (issue details, comments, guidance). */
  promptContext?: string | undefined;
  previousComments?: unknown;
  guidance?: string | undefined;
  webhookTimestamp: number;
}

/** Subset of Linear's AgentSessionEvent webhook payload we consume. */
export type LinearAgentSessionEvent =
  | (LinearAgentSessionEventBase & {
      action: "created";
      agentActivity?: undefined;
    })
  | (LinearAgentSessionEventBase & {
      action: "prompted";
      /**
       * Linear's activity id is the prompted turn's semantic execution id.
       * User text lives in the typed content union; a bare body remains a
       * compatibility fallback for older payloads.
       */
      agentActivity: {
        id: string;
        createdAt?: string | undefined;
        body?: string | undefined;
        content?:
          | { type?: string; body?: string; signal?: string | null }
          | undefined;
        signal?: string | null | undefined;
      };
    });

/** Activity types Linear renders in the agent session thread. */
export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }
  | {
      type: "elicitation";
      body: string;
      /**
       * Bypasses the server's positional `runtime-<sequence>` (and, on a
       * reattach, `reattach-`) activity key in favor of this exact one, so a
       * runtime can guarantee the same Linear activity id across a crash
       * between detecting an event and emitting it, and across an
       * independent reattach that reuses the same execution id (for example an
       * id derived from the external system's own escalation id). Only elicitations
       * support this today — deliberately minimal, so every other runtime
       * and activity type is unaffected.
       */
      stableKey?: string | undefined;
    }
  | { type: "action"; action: string; parameter: string; result?: string };

/** One unit of work handed to a runtime. */
export interface SessionRequest {
  /** Linear agent session id — the stable key across follow-up prompts. */
  linearSessionId: string;
  /** Prompt text (promptContext on created, agentActivity.body on prompted). */
  prompt: string;
  /** Runtime session id from a prior turn, when resuming. */
  resumeSessionId?: string | undefined;
  /** Cancels the active runtime turn for a Linear stop signal or inactivity. */
  abortController?: AbortController | undefined;
  /**
   * Stable id of the bridge turn (the ingress execution id). Runtimes that
   * write to an external system use it as an idempotency seed.
   */
  turnId?: string | undefined;
  /**
   * The body of the human comment that opened a created session (a
   * mention), when the webhook carried one.
   */
  openingComment?: string | undefined;
  /** The turn carries a follow-up prompt rather than the opening one. */
  isFollowUp?: boolean | undefined;
  /** Linear issue identifier (e.g. ENG-12), when known. */
  issueIdentifier?: string | undefined;
  /**
   * Linear issue id (uuid), when known — only ever populated on the turn
   * that opens external work (a `created` dispatch or its reconciliation
   * fallback), from the webhook payload already in scope there. A resumed
   * or reattached turn never needs it, since it never opens anything new.
   */
  issueId?: string | undefined;
  /**
   * The Linear user or app-actor who created or delegated this session
   * (`agentSession.creator.id`), when known — only ever populated on the
   * turn that opens external work, same as `issueId`. A runtime whose work
   * continues outside this process can use it to authorize the actor before
   * opening that work.
   */
  actorId?: string | undefined;
  /**
   * Re-attach to external work already started by an earlier process for
   * this session, without sending the prompt again. Only runtimes that set
   * `reattachAfterRestart` receive it.
   */
  watchOnly?: boolean | undefined;
}

/** Events a runtime yields while working a session. Progress never renders. */
export type RuntimeEvent =
  | { kind: "progress" }
  | {
      kind: "session-started";
      runtimeSessionId: string;
      /**
       * The session linked external work another session owns (one
       * delegation, several Linear sessions). Its stop must not cancel it.
       */
      sharedWork?: boolean | undefined;
      /**
       * Persisted alongside this session record so a runtime that needs
       * them again after a restart can read them back off `SessionRequest`
       * (see `SessionRecord`). Every other runtime, and every other
       * `session-started` event, leaves these unset.
       */
      issueId?: string | undefined;
      actorId?: string | undefined;
    }
  | { kind: "activity"; activity: AgentActivityContent }
  /**
   * The turn has handed its work to an external system and is only watching
   * it. A newer prompt for the session may end the watch silently so the
   * FIFO lane moves on; the newer turn resumes watching.
   */
  | { kind: "watching" }
  | { kind: "done" };

/**
 * The runtime seam. ClaudeRuntime is the default; CodexRuntime is selected
 * with RUNTIME=codex.
 */
export interface AgentRuntime {
  readonly name: string;
  runSession(request: SessionRequest): AsyncIterable<RuntimeEvent>;
  /**
   * Optional synchronous hard-stop control. Returning means the runtime has
   * invoked its underlying resource closer; implementations must be
   * idempotent. The server uses this before releasing a timed-out queue slot.
   */
  forceCloseSession?(request: SessionRequest): void;
  /**
   * Optional hook for a Linear stop signal. Runtimes whose work continues
   * outside this process cancel it here. Aborting the turn's
   * controller alone is not a stop: shutdown and inactivity abort too.
   * Returns an optional sentence appended to the stop response.
   */
  stopSession?(session: {
    linearSessionId: string;
    runtimeSessionId?: string | undefined;
    /** The session only linked work another session owns. */
    sharedWork?: boolean | undefined;
  }): Promise<string | undefined>;
  /**
   * Optional hook for a Linear issue moving to a completed or canceled state
   * Runtimes without it are left alone on issue state changes.
   * `stopped` is true only when this call ended work that was still live,
   * so the caller owes the session one response; a repeat, an
   * already-stopped thread, or an idle one resolves false.
   */
  stopForClosedIssue?(session: {
    linearSessionId: string;
    runtimeSessionId?: string | undefined;
  }): Promise<{ stopped: boolean; confirmedState?: string | undefined }>;
  /**
   * The runtime's external work survives a bridge restart and a watch-only
   * turn can safely re-attach to it instead of reporting the interruption.
   */
  readonly reattachAfterRestart?: boolean;
  /**
   * The runtime emits its own bounded progress activities, so the bridge's
   * periodic "Still working" notices are suppressed.
   */
  readonly suppressProgressNotices?: boolean;
  /**
   * The runtime receives `turnId` and `issueIdentifier` on each request.
   * Off by default so existing runtimes see exactly the request they always
   * did.
   */
  readonly needsTurnContext?: boolean;
}

export class NotImplementedError extends Error {
  constructor(ticket: string) {
    super(`Not implemented — tracked as ${ticket}`);
    this.name = "NotImplementedError";
  }
}
