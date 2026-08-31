import { randomUUID } from "node:crypto";
import type { ActorType, TraceSpan } from "./types.js";

/** Upgrade pre-identity traces once, retaining their existing span/parent IDs. */
export function migrateTraceIdentities(spans: readonly TraceSpan[]): TraceSpan[] {
  const byRun = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    const group = byRun.get(span.runId) ?? [];
    group.push(span);
    byRun.set(span.runId, group);
  }
  const identities = new Map([...byRun].map(([runId, group]) => [runId, {
    traceId: group.find((span) => span.traceId)?.traceId ?? randomUUID(),
    // Never use the Agent's current version/thread as a historical snapshot.
    agentVersion: group.find((span) => Number.isInteger(span.agentVersion) && span.agentVersion > 0)?.agentVersion ?? 1,
    sessionId: group.find((span) => typeof span.sessionId === "string")?.sessionId ?? null,
  }]));
  return spans.map((span) => {
    const identity = identities.get(span.runId)!;
    const inferred: string[] = [];
    const next = { ...span };
    if (!next.traceId) {
      next.traceId = identity.traceId;
      inferred.push("traceId");
    }
    if (!Number.isInteger(next.agentVersion) || next.agentVersion < 1) {
      next.agentVersion = identity.agentVersion;
      inferred.push("agentVersion");
    }
    if (next.sessionId === undefined) {
      next.sessionId = identity.sessionId;
      inferred.push("sessionId");
    }
    if (!next.actorType) {
      const actor: ActorType = span.category === "orchestration" ? "human"
        : span.category === "policy.decision" ? "system" : "agent";
      next.actorType = actor;
      inferred.push("actorType");
    }
    if (inferred.length > 0) {
      next.attributes = { ...next.attributes, legacyIdentityFields: inferred };
    }
    return next;
  });
}
