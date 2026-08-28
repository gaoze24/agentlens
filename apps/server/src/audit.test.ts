import { describe, expect, it } from "vitest";
import { buildAuditBundle } from "./audit.js";
import type { Agent, AgentRun, TraceSpan } from "./types.js";

const agent: Agent = {
  id: "agent-1",
  version: 3,
  name: "Auditor",
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: "/workspace",
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:05.000Z",
};

const run: AgentRun = {
  id: "run-1",
  agentId: agent.id,
  status: "failed",
  prompt: "Use secret-key and Authorization: Bearer abc.def",
  output: null,
  error: "Failed with secret-key",
  usage: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 30 },
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: "2026-01-01T00:00:04.500Z",
  createdAt: "2026-01-01T00:00:00.500Z",
};

const spans: TraceSpan[] = [
  {
    id: "span-1",
    traceId: "trace-1",
    runId: run.id,
    agentId: agent.id,
    agentVersion: 3,
    sessionId: "thread-1",
    actorType: "agent" as const,
    parentSpanId: null,
    category: "orchestration",
    name: "run.orchestration",
    status: "error",
    startedAt: run.startedAt!,
    completedAt: run.completedAt,
    durationMs: 3500,
    attributes: { token: "secret-key" },
    errorMessage: "Bearer abc.def failed",
  },
  {
    id: "span-2",
    traceId: "trace-1",
    runId: run.id,
    agentId: agent.id,
    agentVersion: 3,
    sessionId: "thread-1",
    actorType: "agent" as const,
    parentSpanId: "span-1",
    category: "model.turn",
    name: "model.turn",
    status: "warning",
    startedAt: "2026-01-01T00:00:02.000Z",
    completedAt: "2026-01-01T00:00:03.000Z",
    durationMs: 1000,
    attributes: { type: "turn.completed" },
    errorMessage: null,
  },
  {
    id: "span-3",
    traceId: "trace-1",
    runId: run.id,
    agentId: agent.id,
    agentVersion: 3,
    sessionId: "thread-1",
    actorType: "agent" as const,
    parentSpanId: "span-1",
    category: "tool.call",
    name: "tool.call:command_execution",
    status: "ok",
    startedAt: "2026-01-01T00:00:03.000Z",
    completedAt: "2026-01-01T00:00:03.100Z",
    durationMs: 100,
    attributes: {},
    errorMessage: null,
  },
];

describe("audit bundles", () => {
  it("summarizes a run and redacts secrets again before export", () => {
    const bundle = buildAuditBundle(
      agent,
      run,
      spans,
      ["secret-key"],
      "2026-01-01T00:00:06.000Z",
    );

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.agent).toEqual({ id: agent.id, name: agent.name });
    expect(bundle.summary).toEqual({
      durationMs: 3500,
      inputTokens: 120,
      cachedInputTokens: 40,
      outputTokens: 30,
      totalTokens: 150,
      modelTurns: 1,
      toolCalls: 1,
      warnings: 1,
      errors: 1,
      spanCount: 3,
    });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("secret-key");
    expect(serialized).not.toContain("abc.def");
    expect(serialized).toContain("[REDACTED]");
  });
});
