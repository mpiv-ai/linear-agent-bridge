import { describe, expect, it } from "vitest";
import { LinearAgentClient, type FetchFn } from "../src/linear/client.js";

const APP_USER = "074ec80c-3be0-4425-aec6-3581c0808569";

interface Query {
  query: string;
  variables: Record<string, unknown>;
}

function session(id: string, createdAt: string) {
  return { id, createdAt, appUser: { id: APP_USER } };
}

function issueNode(id: string, sessions: unknown[], hasMore: boolean) {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Issue ${id}`,
    description: "",
    updatedAt: "2026-09-24T12:00:00.000Z",
    delegate: { id: APP_USER },
    agentSessions: {
      nodes: sessions,
      pageInfo: { hasNextPage: hasMore, endCursor: hasMore ? `${id}-sessions-1` : null },
    },
  };
}

function fakeLinear(queries: Query[]): FetchFn {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Query;
    queries.push(body);
    if (body.query.includes("query DelegatedIssues")) {
      if (body.variables.after === undefined) {
        const firstPage = Array.from({ length: 50 }, (_unused, index) =>
          issueNode(`i${index}`, [], false),
        );
        firstPage[0] = issueNode(
          "i0",
          Array.from({ length: 50 }, (_unused, index) =>
            session(`s${index}`, "2026-09-24T11:00:00.000Z"),
          ),
          true,
        );
        return Response.json({
          data: { issues: { nodes: firstPage, pageInfo: { hasNextPage: true, endCursor: "issues-1" } } },
        });
      }
      return Response.json({
        data: {
          issues: {
            nodes: [issueNode("i50", [], false)],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    if (body.query.includes("query DelegationIssueSessions")) {
      return Response.json({
        data: {
          issue: {
            agentSessions: {
              nodes: [session("s50", "2026-09-24T11:30:00.000Z")],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    if (body.query.includes("query DelegationHistory")) {
      const first = body.variables.after === undefined;
      return Response.json({
        data: {
          issue: {
            history: {
              nodes: first
                ? [
                    { id: "h-old", createdAt: "2026-09-20T00:00:00.000Z", toDelegate: { id: APP_USER } },
                    { id: "h-other", createdAt: "2026-09-23T00:00:00.000Z", toDelegate: { id: "someone-else" } },
                  ]
                : [
                    { id: "h-new", createdAt: "2026-09-24T10:00:00.000Z", toDelegate: { id: APP_USER } },
                    { id: "h-edit", createdAt: "2026-09-24T11:00:00.000Z", toDelegate: null },
                  ],
              pageInfo: first
                ? { hasNextPage: true, endCursor: "history-1" }
                : { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    throw new Error(`unexpected query: ${body.query.slice(0, 40)}`);
  }) as FetchFn;
}

// Finding 7b: delegation reads follow every page instead of stopping at 50.
describe("delegation queries page past the first 50", () => {
  it("returns delegated issues and their sessions from every page", async () => {
    const queries: Query[] = [];
    const issues = await new LinearAgentClient("token", fakeLinear(queries)).listDelegatedIssues(
      APP_USER,
      "2026-09-23T00:00:00.000Z",
    );
    expect(issues).toHaveLength(51);
    expect(issues.at(-1)!.id).toBe("i50");
    expect(issues[0]!.agentSessions.map((entry) => entry.id)).toHaveLength(51);
    expect(issues[0]!.agentSessions.at(-1)!.id).toBe("s50");
    expect(
      queries.filter((query) => query.query.includes("DelegationIssueSessions"))[0]!.variables,
    ).toEqual({ id: "i0", after: "i0-sessions-1" });
  });

  it("finds the newest delegation to the app across history pages", async () => {
    const delegation = await new LinearAgentClient("token", fakeLinear([])).getDelegationInstance(
      "i0",
      APP_USER,
    );
    expect(delegation).toEqual({ id: "h-new", createdAt: "2026-09-24T10:00:00.000Z" });
  });
});

// Closing an issue stops its external work, keyed on the state type.
describe("delegation issue workflow state", () => {
  it("reads the issue's workflow state type, and tolerates its absence", async () => {
    const queries: Query[] = [];
    const responses = [
      { ...issueNode("i1", [session("s1", "2026-09-24T11:00:00.000Z")], false), state: { type: "canceled" } },
      issueNode("i2", [], false),
    ];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      queries.push(JSON.parse(String(init?.body)) as Query);
      return Response.json({ data: { issue: responses.shift() } });
    }) as FetchFn;
    const client = new LinearAgentClient("token", fetchFn);

    const canceled = await client.getDelegationIssue("i1");
    const unknown = await client.getDelegationIssue("i2");

    expect(queries[0]!.query).toContain("state { type }");
    expect(canceled.stateType).toBe("canceled");
    expect(canceled.agentSessions.map((entry) => entry.id)).toEqual(["s1"]);
    expect(unknown.stateType).toBeUndefined();
  });
});
