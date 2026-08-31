import { describe, expect, it } from "vitest";
import { migrateTraceIdentities } from "./trace-migration.js";
import { buildRunSpan, completeSpan } from "./trace.js";
import type { TraceSpan } from "./types.js";

function span(runId: string): TraceSpan {
  return completeSpan(buildRunSpan({
    runId, traceId: "trace-" + runId, agentId: "agent", agentVersion: 3, sessionId: "thread-old",
    promptLength: 1, promptPreview: "x", startedAt: "2026-01-01T00:00:00.000Z",
  }), "ok", "2026-01-01T00:00:01.000Z");
}

function legacy(input: TraceSpan): TraceSpan {
  const { traceId, agentVersion, actorType, sessionId, ...rest } = input;
  return rest as TraceSpan;
}

describe("legacy trace identities", () => {
  it("does not change current traces", () => {
    const current = [span("one"), span("two")];
    expect(migrateTraceIdentities(current)).toEqual(current);
  });

  it("reuses known same-Run metadata in a partially upgraded trace", () => {
    const known = span("one");
    const child = legacy({ ...span("one"), parentSpanId: known.id, category: "policy.decision" });
    const migrated = migrateTraceIdentities([known, child]);
    expect(migrated[0]).toEqual(known);
    expect(migrated[1]).toMatchObject({ traceId: known.traceId, agentVersion: 3, sessionId: "thread-old", actorType: "system" });
    expect(child.traceId).toBeUndefined();
    expect(migrateTraceIdentities(migrated)).toEqual(migrated);
  });

  it("assigns different trace IDs to different old Runs", () => {
    const migrated = migrateTraceIdentities([legacy(span("one")), legacy(span("two"))]);
    expect(migrated[0]!.traceId).toBeTruthy();
    expect(migrated[0]!.traceId).not.toBe(migrated[1]!.traceId);
    expect(migrated.every((entry) => entry.agentVersion === 1 && entry.sessionId === null)).toBe(true);
  });
});
