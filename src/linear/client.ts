import type { AgentActivityContent } from "../types.js";
import type { ReconciliationCursor } from "../state/store.js";
import type { LinearCredentialProvider } from "./oauth.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const VIEWER_QUERY = `query BridgeViewer { viewer { id } }`;

const DELEGATION_ISSUE_FIELDS = `
  id
  identifier
  title
  description
  updatedAt
  state { type }
  delegate { id }
  agentSessions(first: 50) {
    nodes { id createdAt appUser { id } }
    pageInfo { hasNextPage endCursor }
  }
`;

const DELEGATION_ISSUE_QUERY = `query DelegationIssue($id: String!) {
  issue(id: $id) { ${DELEGATION_ISSUE_FIELDS} }
}`;

const ISSUE_SESSIONS_PAGE_QUERY = `query DelegationIssueSessions($id: String!, $after: String!) {
  issue(id: $id) {
    agentSessions(first: 50, after: $after) {
      nodes { id createdAt appUser { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const DELEGATED_ISSUES_QUERY = `query DelegatedIssues($appUserId: ID!, $updatedAfter: DateTimeOrDuration!, $after: String) {
  issues(
    first: 50
    after: $after
    filter: { delegate: { id: { eq: $appUserId } }, updatedAt: { gt: $updatedAfter } }
  ) {
    nodes { ${DELEGATION_ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const DELEGATION_HISTORY_QUERY = `query DelegationHistory($id: String!, $after: String) {
  issue(id: $id) {
    history(first: 50, after: $after) {
      nodes { id createdAt toDelegate { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** Bound on pages read from any one delegation connection. */
const MAX_DELEGATION_PAGES = 20;

const AGENT_SESSION_CREATE_ON_ISSUE_MUTATION = `mutation AgentSessionCreateOnIssue($issueId: String!) {
  agentSessionCreateOnIssue(input: { issueId: $issueId }) {
    success
    agentSession { id }
  }
}`;

const AGENT_ACTIVITY_CREATE_MUTATION = `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) {
      success
    }
  }
`;

const RECENT_AGENT_SESSIONS_QUERY = `
  query ReconciliationAgentSessions($first: Int!, $after: String) {
    viewer { id }
    agentSessions(first: $first, after: $after, orderBy: updatedAt) {
      nodes {
        id
        updatedAt
        appUser { id }
        issue { identifier }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const AGENT_SESSION_ACTIVITIES_QUERY = `
  query ReconciliationAgentSessionActivities(
    $sessionId: String!
    $first: Int!
    $after: String
    # Linear's createdAt comparator takes DateTimeOrDuration, not DateTime.
    # Declaring DateTime! makes the server reject the whole query with a 400.
    $lookbackAfter: DateTimeOrDuration!
  ) {
    agentSession(id: $sessionId) {
      id
      createdAt
      appUser { id }
      issue { identifier }
      activities(
        first: $first
        after: $after
        orderBy: createdAt
        filter: { createdAt: { gte: $lookbackAfter } }
      ) {
        nodes {
          id
          createdAt
          signal
          user { id }
          content {
            __typename
            ... on AgentActivityPromptContent { body }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const AUTONOMOUS_GOAL_ISSUE_QUERY = `
  query AutonomousGoalIssue($issueId: String!) {
    issue(id: $issueId) {
      id
      identifier
      labels(first: 250) { nodes { id } }
      state { id type }
      team {
        states(first: 100) { nodes { id type position } }
      }
    }
  }
`;

const COMPLETE_ISSUE_MUTATION = `
  mutation CompleteAutonomousGoalIssue($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
      issue { id state { id type } }
    }
  }
`;

interface GraphQLError {
  message: string;
  /**
   * Linear's GraphQL error extensions. `code === "RATELIMITED"` marks a rate
   * limit response; see https://linear.app/developers/rate-limiting.md.
   * Linear always carries it on an HTTP 400, not the error's own status.
   */
  extensions?:
    | { code?: string | undefined; userPresentableMessage?: string | undefined }
    | undefined;
}

interface AgentActivityCreateResponse {
  data?: {
    agentActivityCreate?: {
      success: boolean;
    };
  };
  errors?: GraphQLError[];
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface LinearAgentSessionSummary {
  id: string;
  updatedAt: string;
  appUserId: string;
  issueIdentifier?: string | undefined;
}

export type ReconciledAgentActivityType =
  | "action"
  | "elicitation"
  | "error"
  | "prompt"
  | "response"
  | "thought";

export interface ReconciledAgentActivity extends ReconciliationCursor {
  /** Absent on app-generated output, which carries no Linear user. */
  userId?: string | undefined;
  type: ReconciledAgentActivityType;
  signal?: string | undefined;
  body?: string | undefined;
}

export interface LinearAgentSessionActivities {
  id: string;
  /**
   * When Linear created the session. Compared against the durable watchingSince
   * marker to tell a session the bridge simply never saw from one whose opening
   * webhook was lost while it was running.
   */
  createdAt: string;
  appUserId: string;
  issueIdentifier?: string | undefined;
  activities: ReconciledAgentActivity[];
}

export interface AutonomousGoalIssueContext {
  issueId: string;
  issueIdentifier: string;
  authorized: boolean;
  alreadyCompleted: boolean;
  currentStateId: string;
  completedStateId?: string | undefined;
}

/** Static, body-free failure surfaced to ingress orchestration and logs. */
export class LinearActivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearActivityError";
  }
}

export class LinearQueryError extends Error {
  /**
   * `detail` is Linear's own error text (code and validation message), made
   * safe to show: requests carry credentials only in headers, so Linear's
   * error body never holds a token.
   */
  constructor(
    operation: string,
    failure: "http" | "graphql" | "shape" | "rate_limited",
    detail?: string,
  ) {
    super(
      `Linear ${operation} query failed: ${failure}${detail === undefined || detail === "" ? "" : ` (${detail})`}`,
    );
    this.name = "LinearQueryError";
  }
}

const MAX_ERROR_DETAIL_CHARS = 300;

/** Linear's first GraphQL error as one bounded, printable line. */
function graphQLErrorDetail(errors: GraphQLError[]): string | undefined {
  const first = errors[0];
  if (first === undefined) {
    return undefined;
  }
  const parts = [
    first.extensions?.code,
    first.message,
    first.extensions?.userPresentableMessage !== first.message
      ? first.extensions?.userPresentableMessage
      : undefined,
  ].filter((part): part is string => typeof part === "string" && part.trim() !== "");
  const line = parts
    .join(": ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length <= MAX_ERROR_DETAIL_CHARS
    ? line
    : `${line.slice(0, MAX_ERROR_DETAIL_CHARS - 1)}…`;
}

/** Signature-compatible subset of the global `fetch` used for injection. */
export type FetchFn = typeof fetch;

/**
 * Reject with the caller's abort reason the moment the signal fires, and
 * detach from `promise` so a later rejection cannot overwrite that reason.
 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Release an unused HTTP response without decoding or exposing its body. */
export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the caller's bounded HTTP error when cleanup itself fails.
  }
}

/**
 * Bounded retry policy for rate-limited and transient Linear GraphQL
 * responses (GH #10). Linear's docs specify the RATELIMITED error shape and
 * the epoch-millisecond reset headers, but not a required client retry count
 * or backoff formula, so these are the bridge's own bounded defaults, chosen
 * to stay well inside the "first activity < 10s" latency budget rather than
 * derived from Linear's documentation:
 * https://linear.app/developers/rate-limiting.md
 */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 1500;
const RATELIMITED_CODE = "RATELIMITED";
/**
 * Reset headers Linear documents, most specific first: an endpoint-specific
 * limit takes priority over the general per-hour request limit when both are
 * present. Both carry a UTC epoch-millisecond reset time.
 */
const RATELIMIT_RESET_HEADERS = [
  "X-RateLimit-Endpoint-Requests-Reset",
  "X-RateLimit-Requests-Reset",
] as const;

function backoffDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

/** Clamped so a distant reset (the window is hourly) cannot itself balloon
 * a latency-bounded caller; never negative for an already-past reset. */
function rateLimitResetDelayMs(headers: Headers): number | undefined {
  for (const name of RATELIMIT_RESET_HEADERS) {
    const raw = headers.get(name);
    if (raw === null) {
      continue;
    }
    const resetAtMs = Number(raw);
    if (Number.isFinite(resetAtMs)) {
      return Math.min(Math.max(resetAtMs - Date.now(), 0), RETRY_MAX_DELAY_MS);
    }
  }
  return undefined;
}

function rateLimitDelayMs(headers: Headers, attempt: number): number {
  return rateLimitResetDelayMs(headers) ?? backoffDelayMs(attempt);
}

function parseGraphQLErrors(json: unknown): GraphQLError[] {
  const errors = asRecord(json)?.errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  const parsed: GraphQLError[] = [];
  for (const raw of errors) {
    const record = asRecord(raw);
    if (record === undefined) {
      continue;
    }
    const extensions = asRecord(record.extensions);
    parsed.push({
      message: typeof record.message === "string" ? record.message : "",
      extensions:
        extensions !== undefined
          ? {
              code:
                typeof extensions.code === "string" ? extensions.code : undefined,
              userPresentableMessage:
                typeof extensions.userPresentableMessage === "string"
                  ? extensions.userPresentableMessage
                  : undefined,
            }
          : undefined,
    });
  }
  return parsed;
}

function hasRateLimitedError(errors: GraphQLError[]): boolean {
  return errors.some((error) => error.extensions?.code === RATELIMITED_CODE);
}

type ResponseClassification =
  | { kind: "success"; json: unknown }
  | { kind: "retry"; rateLimited: boolean; response: Response }
  | { kind: "fatal"; graphqlError: boolean; errors?: GraphQLError[] };

/**
 * Classifies a completed (post-401-refresh) Linear GraphQL response.
 * - Any 5xx is transient and retried without inspecting the body.
 * - A 400 is inspected for `errors[].extensions.code === "RATELIMITED"`
 *   (Linear's documented shape); a match is retried honoring reset headers,
 *   anything else on a 400 is a permanent (e.g. validation) failure.
 * - Any other non-ok status is a permanent failure, never retried blindly.
 * - An ok response with a non-empty `errors` array is also permanent: Linear
 *   only documents RATELIMITED arriving on HTTP 400.
 */
async function classifyGraphQLResponse(
  response: Response,
): Promise<ResponseClassification> {
  if (response.status >= 500 && response.status <= 599) {
    await discardResponseBody(response);
    return { kind: "retry", rateLimited: false, response };
  }
  if (response.status === 400) {
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { kind: "fatal", graphqlError: false };
    }
    const errors = parseGraphQLErrors(json);
    if (hasRateLimitedError(errors)) {
      return { kind: "retry", rateLimited: true, response };
    }
    return { kind: "fatal", graphqlError: errors.length > 0, errors };
  }
  if (!response.ok) {
    await discardResponseBody(response);
    return { kind: "fatal", graphqlError: false };
  }
  const json = await response.json();
  const errors = parseGraphQLErrors(json);
  if (errors.length > 0) {
    return { kind: "fatal", graphqlError: true, errors };
  }
  return { kind: "success", json };
}

/** Bounded backoff wait that rejects with the caller's abort reason the
 * moment the signal fires, instead of swallowing it until the timer ends. */
function waitBounded(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Thin Linear GraphQL client for the Agent Interaction API.
 * Emits agent activities via the `agentActivityCreate` mutation:
 *
 *   mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
 *     agentActivityCreate(input: $input) { success }
 *   }
 *
 * Input carries `agentSessionId` and `content` (shaped by activity type).
 * Timing rules from Linear's docs: respond to a webhook within 5s and, on
 * `created`, emit an activity within 10s or the session is marked
 * unresponsive — the server acks first, then works.
 */
export class LinearAgentClient {
  constructor(
    private readonly tokenSource: string | LinearCredentialProvider,
    private readonly fetchFn: FetchFn = globalThis.fetch,
  ) {}

  async createActivity(
    agentSessionId: string,
    content: AgentActivityContent,
    options: {
      activityId?: string;
      ephemeral?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    let json: unknown;
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      options.signal?.throwIfAborted();
      const accessToken = await abortable(
        this.getAccessToken(options.signal),
        options.signal,
      );
      let response = await this.postActivity(
        accessToken,
        agentSessionId,
        content,
        options,
      );

      if (response.status === 401 && typeof this.tokenSource !== "string") {
        await discardResponseBody(response);
        const refreshedAccessToken = await abortable(
          this.tokenSource.refreshAfterUnauthorized(accessToken, options.signal),
          options.signal,
        );
        response = await this.postActivity(
          refreshedAccessToken,
          agentSessionId,
          content,
          options,
        );
      }

      const classification = await classifyGraphQLResponse(response);
      if (classification.kind === "success") {
        json = classification.json;
        break;
      }
      if (classification.kind === "retry" && attempt < RETRY_MAX_ATTEMPTS) {
        const delayMs = classification.rateLimited
          ? rateLimitDelayMs(classification.response.headers, attempt)
          : backoffDelayMs(attempt);
        await waitBounded(delayMs, options.signal);
        continue;
      }
      if (classification.kind === "retry") {
        throw new LinearActivityError(
          classification.rateLimited
            ? `Linear agentActivityCreate failed: rate limited (${RATELIMITED_CODE}), retries exhausted`
            : `Linear agentActivityCreate failed: ${response.status} ${response.statusText}`,
        );
      }
      throw new LinearActivityError(
        classification.graphqlError
          ? "Linear agentActivityCreate GraphQL error"
          : `Linear agentActivityCreate failed: ${response.status} ${response.statusText}`,
      );
    }

    const parsed = json as AgentActivityCreateResponse;
    if (parsed.data?.agentActivityCreate?.success !== true) {
      throw new LinearActivityError(
        "Linear agentActivityCreate returned success: false with no GraphQL errors",
      );
    }
  }

  async listRecentAppOwnedSessions(options: {
    updatedAfter: string;
    maxSessions: number;
    signal?: AbortSignal | undefined;
  }): Promise<LinearAgentSessionSummary[]> {
    validateTimestamp(options.updatedAfter, "updatedAfter");
    if (
      !Number.isInteger(options.maxSessions) ||
      options.maxSessions <= 0 ||
      options.maxSessions > 250
    ) {
      throw new Error("maxSessions must be an integer from 1 to 250");
    }

    const sessions: LinearAgentSessionSummary[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    while (sessions.length < options.maxSessions) {
      const json = await this.queryGraphQL(
        RECENT_AGENT_SESSIONS_QUERY,
        { first: 50, after },
        "agentSessions",
        options.signal,
      );
      const data = asRecord(asRecord(json)?.data);
      const viewer = asRecord(data?.viewer);
      const connection = asRecord(data?.agentSessions);
      const viewerId = viewer?.id;
      const nodes = connection?.nodes;
      const pageInfo = parsePageInfo(connection?.pageInfo, "agentSessions");
      if (typeof viewerId !== "string" || !Array.isArray(nodes)) {
        throw new LinearQueryError("agentSessions", "shape");
      }

      let pageReachedLookback = false;
      for (const rawNode of nodes) {
        const node = asRecord(rawNode);
        const appUser = asRecord(node?.appUser);
        if (
          typeof node?.id !== "string" ||
          typeof node.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(node.updatedAt)) ||
          typeof appUser?.id !== "string"
        ) {
          throw new LinearQueryError("agentSessions", "shape");
        }
        if (Date.parse(node.updatedAt) < Date.parse(options.updatedAfter)) {
          pageReachedLookback = true;
          continue;
        }
        if (appUser.id !== viewerId) {
          continue;
        }
        const issueIdentifier = asRecord(node.issue)?.identifier;
        sessions.push({
          id: node.id,
          updatedAt: node.updatedAt,
          appUserId: appUser.id,
          ...(typeof issueIdentifier === "string" ? { issueIdentifier } : {}),
        });
        if (sessions.length >= options.maxSessions) {
          break;
        }
      }

      if (!pageInfo.hasNextPage || pageReachedLookback) {
        break;
      }
      after = nextPageCursor(pageInfo, seenCursors, nodes.length, "agentSessions");
    }
    return sessions;
  }

  async getAutonomousGoalIssueContext(
    issueId: string,
    labelId: string,
    signal?: AbortSignal,
  ): Promise<AutonomousGoalIssueContext> {
    if (issueId.length === 0 || labelId.length === 0) {
      throw new Error("issueId and labelId must not be empty");
    }
    const json = await this.queryGraphQL(
      AUTONOMOUS_GOAL_ISSUE_QUERY,
      { issueId },
      "autonomousGoalIssue",
      signal,
    );
    const issue = asRecord(asRecord(asRecord(json)?.data)?.issue);
    const labels = asRecord(issue?.labels)?.nodes;
    const state = asRecord(issue?.state);
    const states = asRecord(asRecord(issue?.team)?.states)?.nodes;
    if (
      typeof issue?.id !== "string" ||
      typeof issue.identifier !== "string" ||
      !Array.isArray(labels) ||
      typeof state?.id !== "string" ||
      typeof state.type !== "string" ||
      !Array.isArray(states)
    ) {
      throw new LinearQueryError("autonomousGoalIssue", "shape");
    }
    const labelIds = labels.map((value) => asRecord(value)?.id);
    if (labelIds.some((value) => typeof value !== "string")) {
      throw new LinearQueryError("autonomousGoalIssue", "shape");
    }
    const completedStates = states
      .map((value) => asRecord(value))
      .filter(
        (value): value is Record<string, unknown> =>
          typeof value?.id === "string" &&
          value.type === "completed" &&
          typeof value.position === "number",
      )
      .sort((left, right) =>
        (left.position as number) - (right.position as number),
      );
    return {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      authorized: labelIds.includes(labelId),
      alreadyCompleted: state.type === "completed",
      currentStateId: state.id,
      ...(completedStates[0] !== undefined
        ? { completedStateId: completedStates[0].id as string }
        : {}),
    };
  }

  async completeIssue(
    issueId: string,
    stateId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (issueId.length === 0 || stateId.length === 0) {
      throw new Error("issueId and stateId must not be empty");
    }
    const json = await this.queryGraphQL(
      COMPLETE_ISSUE_MUTATION,
      { issueId, stateId },
      "completeAutonomousGoalIssue",
      signal,
    );
    const payload = asRecord(
      asRecord(asRecord(json)?.data)?.issueUpdate,
    );
    const issue = asRecord(payload?.issue);
    const state = asRecord(issue?.state);
    if (
      payload?.success !== true ||
      issue?.id !== issueId ||
      state?.id !== stateId ||
      state.type !== "completed"
    ) {
      throw new LinearQueryError("completeAutonomousGoalIssue", "shape");
    }
  }

  async listAgentSessionActivities(
    sessionId: string,
    options: {
      lookbackAfter: string;
      processedThrough?: ReconciliationCursor | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<LinearAgentSessionActivities> {
    if (sessionId.length === 0) {
      throw new Error("sessionId must not be empty");
    }
    validateTimestamp(options.lookbackAfter, "lookbackAfter");

    const activities: ReconciledAgentActivity[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    let session: Omit<LinearAgentSessionActivities, "activities"> | undefined;
    while (true) {
      const json = await this.queryGraphQL(
        AGENT_SESSION_ACTIVITIES_QUERY,
        {
          sessionId,
          first: 50,
          after,
          lookbackAfter: options.lookbackAfter,
        },
        "agentSessionActivities",
        options.signal,
      );
      const rawSession = asRecord(asRecord(asRecord(json)?.data)?.agentSession);
      const appUser = asRecord(rawSession?.appUser);
      const connection = asRecord(rawSession?.activities);
      const nodes = connection?.nodes;
      const pageInfo = parsePageInfo(
        connection?.pageInfo,
        "agentSessionActivities",
      );
      if (
        typeof rawSession?.id !== "string" ||
        typeof rawSession.createdAt !== "string" ||
        !Number.isFinite(Date.parse(rawSession.createdAt)) ||
        typeof appUser?.id !== "string" ||
        !Array.isArray(nodes)
      ) {
        throw new LinearQueryError("agentSessionActivities", "shape");
      }
      const issueIdentifier = asRecord(rawSession.issue)?.identifier;
      session = {
        id: rawSession.id,
        createdAt: rawSession.createdAt,
        appUserId: appUser.id,
        ...(typeof issueIdentifier === "string" ? { issueIdentifier } : {}),
      };

      let reachedWatermark = false;
      for (const rawNode of nodes) {
        const activity = parseAgentActivity(rawNode);
        if (options.processedThrough !== undefined) {
          const activityTime = Date.parse(activity.createdAt);
          const watermarkTime = Date.parse(options.processedThrough.createdAt);
          if (activityTime < watermarkTime) {
            reachedWatermark = true;
            continue;
          }
          // At the watermark timestamp only the watermark activity itself is
          // known-processed. Ids do not order the connection and Date.parse
          // collapses finer precision, so a same-millisecond sibling is
          // re-offered rather than skipped: the durable semantic claim
          // deduplicates a repeat, while skipping drops the prompt forever.
          if (
            activityTime === watermarkTime &&
            activity.id === options.processedThrough.id
          ) {
            continue;
          }
        }
        if (
          Date.parse(activity.createdAt) < Date.parse(options.lookbackAfter)
        ) {
          continue;
        }
        activities.push(activity);
      }
      if (!pageInfo.hasNextPage || reachedWatermark) {
        break;
      }
      after = nextPageCursor(
        pageInfo,
        seenCursors,
        nodes.length,
        "agentSessionActivities",
      );
    }

    activities.sort(compareActivityCursor);
    return { ...session!, activities };
  }

  /** The app user this client's token acts as (`viewer { id }`). */
  async getViewerId(signal?: AbortSignal): Promise<string> {
    const json = await this.queryGraphQL(VIEWER_QUERY, {}, "viewer", signal);
    const id = asRecord(asRecord(asRecord(json)?.data)?.viewer)?.id;
    if (typeof id !== "string") {
      throw new LinearQueryError("viewer", "shape");
    }
    return id;
  }

  /** An issue with its delegate and every Agent Session on it (paged). */
  async getDelegationIssue(
    issueId: string,
    signal?: AbortSignal,
  ): Promise<DelegationIssue> {
    const json = await this.queryGraphQL(
      DELEGATION_ISSUE_QUERY,
      { id: issueId },
      "delegationIssue",
      signal,
    );
    const raw = asRecord(asRecord(json)?.data)?.issue;
    const issue = parseDelegationIssue(raw);
    if (issue === undefined) {
      throw new LinearQueryError("delegationIssue", "shape");
    }
    return await this.completeSessions(issue, raw, signal);
  }

  /** Issues currently delegated to `appUserId`, updated after a bound (paged). */
  async listDelegatedIssues(
    appUserId: string,
    updatedAfter: string,
    signal?: AbortSignal,
  ): Promise<DelegationIssue[]> {
    validateTimestamp(updatedAfter, "updatedAfter");
    const issues: DelegationIssue[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < MAX_DELEGATION_PAGES; page += 1) {
      const json = await this.queryGraphQL(
        DELEGATED_ISSUES_QUERY,
        { appUserId, updatedAfter, ...(after !== undefined ? { after } : {}) },
        "delegatedIssues",
        signal,
      );
      const connection = asRecord(asRecord(asRecord(json)?.data)?.issues);
      const nodes = connection?.nodes;
      if (!Array.isArray(nodes)) {
        throw new LinearQueryError("delegatedIssues", "shape");
      }
      for (const node of nodes) {
        const issue = parseDelegationIssue(node);
        if (issue === undefined) {
          throw new LinearQueryError("delegatedIssues", "shape");
        }
        issues.push(await this.completeSessions(issue, node, signal));
      }
      const pageInfo = parsePageInfo(connection?.pageInfo, "delegatedIssues");
      if (!pageInfo.hasNextPage) {
        return issues;
      }
      after = nextPageCursor(pageInfo, seen, nodes.length, "delegatedIssues");
    }
    throw new LinearQueryError("delegatedIssues", "shape");
  }

  /**
   * The current delegation of an issue to `appUserId`: the newest history
   * entry that set it as delegate. Each delegation, including a repeat to
   * the same app, is a distinct entry, so its id names that instance.
   */
  async getDelegationInstance(
    issueId: string,
    appUserId: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; createdAt: string } | undefined> {
    let newest: { id: string; createdAt: string } | undefined;
    const seen = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < MAX_DELEGATION_PAGES; page += 1) {
      const json = await this.queryGraphQL(
        DELEGATION_HISTORY_QUERY,
        { id: issueId, ...(after !== undefined ? { after } : {}) },
        "delegationHistory",
        signal,
      );
      const connection = asRecord(asRecord(asRecord(asRecord(json)?.data)?.issue)?.history);
      const nodes = connection?.nodes;
      if (!Array.isArray(nodes)) {
        throw new LinearQueryError("delegationHistory", "shape");
      }
      for (const raw of nodes) {
        const entry = asRecord(raw);
        if (
          typeof entry?.id === "string" &&
          typeof entry.createdAt === "string" &&
          asRecord(entry.toDelegate)?.id === appUserId &&
          (newest === undefined ||
            Date.parse(entry.createdAt) > Date.parse(newest.createdAt))
        ) {
          newest = { id: entry.id, createdAt: entry.createdAt };
        }
      }
      const pageInfo = parsePageInfo(connection?.pageInfo, "delegationHistory");
      if (!pageInfo.hasNextPage) {
        return newest;
      }
      after = nextPageCursor(pageInfo, seen, nodes.length, "delegationHistory");
    }
    throw new LinearQueryError("delegationHistory", "shape");
  }

  /** Follow an issue's agentSessions connection past its first page. */
  private async completeSessions(
    issue: DelegationIssue,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<DelegationIssue> {
    const seen = new Set<string>();
    let pageInfo = parsePageInfo(
      asRecord(asRecord(raw)?.agentSessions)?.pageInfo,
      "delegationIssue",
    );
    let count = issue.agentSessions.length;
    for (let page = 1; pageInfo.hasNextPage; page += 1) {
      if (page >= MAX_DELEGATION_PAGES) {
        throw new LinearQueryError("delegationIssue", "shape");
      }
      const after = nextPageCursor(pageInfo, seen, count, "delegationIssue");
      const json = await this.queryGraphQL(
        ISSUE_SESSIONS_PAGE_QUERY,
        { id: issue.id, after },
        "delegationIssueSessions",
        signal,
      );
      const connection = asRecord(
        asRecord(asRecord(asRecord(json)?.data)?.issue)?.agentSessions,
      );
      const parsed = parseSessionNodes(connection?.nodes);
      if (parsed === undefined) {
        throw new LinearQueryError("delegationIssueSessions", "shape");
      }
      issue.agentSessions.push(...parsed);
      count = parsed.length;
      pageInfo = parsePageInfo(connection?.pageInfo, "delegationIssueSessions");
    }
    return issue;
  }

  /** Open an Agent Session for this client's own app on an issue. */
  async createAgentSessionOnIssue(
    issueId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const json = await this.queryGraphQL(
      AGENT_SESSION_CREATE_ON_ISSUE_MUTATION,
      { issueId },
      "agentSessionCreateOnIssue",
      signal,
    );
    const payload = asRecord(asRecord(asRecord(json)?.data)?.agentSessionCreateOnIssue);
    const id = asRecord(payload?.agentSession)?.id;
    if (payload?.success !== true || typeof id !== "string") {
      throw new LinearQueryError("agentSessionCreateOnIssue", "shape");
    }
    return id;
  }

  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (typeof this.tokenSource === "string") {
      signal?.throwIfAborted();
      return this.tokenSource;
    }
    return await this.tokenSource.getAccessToken(signal);
  }

  private async queryGraphQL(
    query: string,
    variables: Record<string, unknown>,
    operation: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      const accessToken = await this.getAccessToken(signal);
      let response = await this.postQuery(accessToken, query, variables, signal);
      if (response.status === 401 && typeof this.tokenSource !== "string") {
        await discardResponseBody(response);
        const refreshedAccessToken =
          await this.tokenSource.refreshAfterUnauthorized(accessToken, signal);
        response = await this.postQuery(
          refreshedAccessToken,
          query,
          variables,
          signal,
        );
      }

      const classification = await classifyGraphQLResponse(response);
      if (classification.kind === "success") {
        return classification.json;
      }
      if (classification.kind === "retry" && attempt < RETRY_MAX_ATTEMPTS) {
        const delayMs = classification.rateLimited
          ? rateLimitDelayMs(classification.response.headers, attempt)
          : backoffDelayMs(attempt);
        await waitBounded(delayMs, signal);
        continue;
      }
      throw new LinearQueryError(
        operation,
        classification.kind === "retry"
          ? "rate_limited"
          : classification.graphqlError
            ? "graphql"
            : "http",
        classification.kind === "fatal" && classification.errors !== undefined
          ? graphQLErrorDetail(classification.errors)
          : undefined,
      );
    }
    throw new LinearQueryError(operation, "http");
  }

  private postQuery(
    accessToken: string,
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.fetchFn(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  private postActivity(
    accessToken: string,
    agentSessionId: string,
    content: AgentActivityContent,
    options: {
      activityId?: string;
      ephemeral?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    return this.fetchFn(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: AGENT_ACTIVITY_CREATE_MUTATION,
        variables: {
          input: {
            ...(options.activityId !== undefined ? { id: options.activityId } : {}),
            agentSessionId,
            content,
            ...(options.ephemeral !== undefined
              ? { ephemeral: options.ephemeral }
              : {}),
          },
        },
      }),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsePageInfo(value: unknown, operation: string): PageInfo {
  const pageInfo = asRecord(value);
  if (
    typeof pageInfo?.hasNextPage !== "boolean" ||
    (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string")
  ) {
    throw new LinearQueryError(operation, "shape");
  }
  return {
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor as string | null,
  };
}

function nextPageCursor(
  pageInfo: PageInfo,
  seen: Set<string>,
  nodeCount: number,
  operation: string,
): string {
  const cursor = pageInfo.endCursor;
  if (
    !pageInfo.hasNextPage ||
    cursor === null ||
    cursor === "" ||
    nodeCount === 0 ||
    seen.has(cursor)
  ) {
    throw new LinearQueryError(operation, "shape");
  }
  seen.add(cursor);
  return cursor;
}

const ACTIVITY_TYPENAMES: Record<string, ReconciledAgentActivityType> = {
  AgentActivityActionContent: "action",
  AgentActivityElicitationContent: "elicitation",
  AgentActivityErrorContent: "error",
  AgentActivityPromptContent: "prompt",
  AgentActivityResponseContent: "response",
  AgentActivityThoughtContent: "thought",
};

export interface DelegationIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | undefined;
  updatedAt: string;
  /** The workflow state's type (`started`, `completed`, `canceled`, ...), when Linear reports one. */
  stateType?: string | undefined;
  delegateId?: string | undefined;
  agentSessions: Array<{ id: string; createdAt: string; appUserId: string }>;
}

function parseSessionNodes(
  value: unknown,
): DelegationIssue["agentSessions"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sessions: DelegationIssue["agentSessions"] = [];
  for (const raw of value) {
    const session = asRecord(raw);
    const appUserId = asRecord(session?.appUser)?.id;
    if (
      typeof session?.id !== "string" ||
      typeof session.createdAt !== "string" ||
      typeof appUserId !== "string"
    ) {
      return undefined;
    }
    sessions.push({ id: session.id, createdAt: session.createdAt, appUserId });
  }
  return sessions;
}

function parseDelegationIssue(value: unknown): DelegationIssue | undefined {
  const issue = asRecord(value);
  const agentSessions = parseSessionNodes(asRecord(issue?.agentSessions)?.nodes);
  if (
    typeof issue?.id !== "string" ||
    typeof issue.identifier !== "string" ||
    typeof issue.title !== "string" ||
    typeof issue.updatedAt !== "string" ||
    agentSessions === undefined
  ) {
    return undefined;
  }
  const delegateId = asRecord(issue.delegate)?.id;
  const stateType = asRecord(issue.state)?.type;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    ...(typeof issue.description === "string" ? { description: issue.description } : {}),
    updatedAt: issue.updatedAt,
    ...(typeof stateType === "string" ? { stateType } : {}),
    ...(typeof delegateId === "string" ? { delegateId } : {}),
    agentSessions,
  };
}

function parseAgentActivity(value: unknown): ReconciledAgentActivity {
  const activity = asRecord(value);
  const user = asRecord(activity?.user);
  const content = asRecord(activity?.content);
  const type =
    typeof content?.__typename === "string"
      ? ACTIVITY_TYPENAMES[content.__typename]
      : undefined;
  if (
    typeof activity?.id !== "string" ||
    typeof activity.createdAt !== "string" ||
    !Number.isFinite(Date.parse(activity.createdAt)) ||
    type === undefined
  ) {
    throw new LinearQueryError("agentSessionActivities", "shape");
  }
  if (
    type === "prompt" &&
    (typeof user?.id !== "string" || typeof content?.body !== "string")
  ) {
    throw new LinearQueryError("agentSessionActivities", "shape");
  }
  return {
    id: activity.id,
    createdAt: activity.createdAt,
    type,
    ...(typeof user?.id === "string" ? { userId: user.id } : {}),
    ...(typeof activity.signal === "string" ? { signal: activity.signal } : {}),
    ...(type === "prompt" ? { body: content!.body as string } : {}),
  };
}

function compareActivityCursor(
  left: ReconciliationCursor,
  right: ReconciliationCursor,
): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

function validateTimestamp(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO-8601 timestamp`);
  }
}
