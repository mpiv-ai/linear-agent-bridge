import type { DelegationIssue } from "./linear/client.js";

/**
 * A `created` AgentSessionEvent the bridge dispatches for an Agent Session it
 * opened itself as the fallback for a delegation that never produced a
 * session. It flows through the normal durable ingress
 * path, keyed `created:<agentSessionId>`, so a real `created` webhook for the
 * same session is a duplicate and can never dispatch the work twice.
 */
export function syntheticCreatedEvent(input: {
  agentSessionId: string;
  issue: Pick<DelegationIssue, "id" | "identifier" | "title" | "description">;
  oauthClientId: string;
  appUserId?: string | undefined;
  now?: number;
}): Record<string, unknown> {
  return {
    type: "AgentSessionEvent",
    action: "created",
    webhookId: "bridge-synthetic",
    webhookTimestamp: input.now ?? Date.now(),
    oauthClientId: input.oauthClientId,
    ...(input.appUserId !== undefined ? { appUserId: input.appUserId } : {}),
    agentSession: {
      id: input.agentSessionId,
      issue: {
        id: input.issue.id,
        identifier: input.issue.identifier,
        title: input.issue.title,
      },
    },
    promptContext: delegationPromptContext(input.issue),
  };
}

/** Linear-style prompt context built from the issue itself. */
export function delegationPromptContext(
  issue: Pick<DelegationIssue, "identifier" | "title" | "description">,
): string {
  const description =
    issue.description === undefined || issue.description.trim() === ""
      ? ""
      : `\n<description>${escapeXml(issue.description)}</description>`;
  return `<issue identifier="${escapeXml(issue.identifier)}">\n<title>${escapeXml(issue.title)}</title>${description}\n</issue>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
