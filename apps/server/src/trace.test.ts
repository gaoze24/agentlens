import { describe, expect, it } from "vitest";
import {
  buildEventSpans,
  buildProcessSpan,
  buildRunSpan,
  completeSpan,
  redactAttributes,
  redactSecrets,
} from "./trace.js";
import type { RawCodexEvent } from "./types.js";

const SECRET = "ark-secret-key-do-not-leak";

describe("redactSecrets", () => {
  it("replaces every occurrence of a known secret", () => {
    const result = redactSecrets(`key=${SECRET} again=${SECRET}`, [SECRET]);
    expect(result).not.toContain(SECRET);
    expect(result).toBe("key=[REDACTED] again=[REDACTED]");
  });

  it("redacts bearer tokens even when the secret list is empty", () => {
    const result = redactSecrets("Authorization: Bearer abc.def-123", []);
    expect(result).toBe("Authorization: Bearer [REDACTED]");
  });

  it("truncates oversized strings", () => {
    const long = "a".repeat(5_000);
    const result = redactSecrets(long, []);
    expect(result.length).toBeLessThan(long.length);
    expect(result.endsWith("…[truncated]")).toBe(true);
  });

  it("is a no-op on clean, short input", () => {
    expect(redactSecrets("hello world", [SECRET])).toBe("hello world");
  });
});

describe("redactAttributes", () => {
  it("redacts secrets nested inside objects and arrays without losing structure", () => {
    const attributes = {
      command: ["run", SECRET],
      nested: { header: `Bearer ${SECRET}` },
      count: 3,
    };
    const result = redactAttributes(attributes, [SECRET]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.count).toBe(3);
    expect(Array.isArray((result as { command: unknown }).command)).toBe(true);
  });
});

describe("span construction", () => {
  it("builds a run span with no parent", () => {
    const span = buildRunSpan({
      runId: "run-1",
      agentId: "agent-1",
      promptLength: 12,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(span.parentSpanId).toBeNull();
    expect(span.category).toBe("orchestration");
    expect(span.status).toBe("ok");
  });

  it("links a process span to its parent run span", () => {
    const runSpan = buildRunSpan({
      runId: "run-1",
      agentId: "agent-1",
      promptLength: 12,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const processSpan = buildProcessSpan({
      runId: "run-1",
      agentId: "agent-1",
      parentSpanId: runSpan.id,
      startedAt: "2026-01-01T00:00:01.000Z",
      sandboxMode: "workspace-write",
      runtimeProvider: "container",
      containerEngine: "docker",
    });
    expect(processSpan.parentSpanId).toBe(runSpan.id);
    expect(processSpan.attributes.containerEngine).toBe("docker");
  });

  it("computes duration and status when a span completes successfully", () => {
    const span = buildRunSpan({
      runId: "run-1",
      agentId: "agent-1",
      promptLength: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const completed = completeSpan(span, "ok", "2026-01-01T00:00:02.500Z");
    expect(completed.status).toBe("ok");
    expect(completed.durationMs).toBe(2_500);
    expect(completed.errorMessage).toBeNull();
  });

  it("marks a cancelled span distinctly from a failed one", () => {
    const span = buildRunSpan({
      runId: "run-1",
      agentId: "agent-1",
      promptLength: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const cancelled = completeSpan(span, "cancelled", "2026-01-01T00:00:01.000Z", null);
    const failed = completeSpan(span, "error", "2026-01-01T00:00:01.000Z", "boom");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.errorMessage).toBeNull();
    expect(failed.status).toBe("error");
    expect(failed.errorMessage).toBe("boom");
  });
});

describe("buildEventSpans", () => {
  const context = { runId: "run-1", agentId: "agent-1", parentSpanId: "process-1" };

  it("categorizes an agent_message item as a model.message span", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.100Z",
        event: { type: "item.completed", item: { type: "agent_message", text: "hi" } },
      },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.category).toBe("model.message");
    expect(spans[0]?.status).toBe("ok");
    expect(spans[0]?.parentSpanId).toBe("process-1");
  });

  it("marks an error event as a failed span and redacts its message", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.200Z",
        event: { type: "error", message: `auth failed for ${SECRET}` },
      },
    ];
    const spans = buildEventSpans(events, context, [SECRET]);
    expect(spans[0]?.category).toBe("runtime.error");
    expect(spans[0]?.status).toBe("error");
    expect(spans[0]?.errorMessage).not.toContain(SECRET);
  });

  it("flags a nested item.type: error as a failed span with its message extracted", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.150Z",
        event: {
          type: "item.completed",
          item: {
            id: "item_0",
            type: "error",
            message: `Model metadata for ${SECRET} not found.`,
          },
        },
      },
    ];
    const spans = buildEventSpans(events, context, [SECRET]);
    expect(spans[0]?.category).toBe("runtime.error");
    expect(spans[0]?.status).toBe("error");
    expect(spans[0]?.errorMessage).toContain("Model metadata for");
    expect(spans[0]?.errorMessage).not.toContain(SECRET);
  });

  it("falls back to an unknown.<type> category for unrecognized item types", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.300Z",
        event: { type: "item.completed", item: { type: "web_search" } },
      },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans[0]?.category).toBe("unknown.web_search");
    expect(spans[0]?.status).toBe("ok");
  });

  it("never leaks a planted secret through any span produced from a batch of events", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.100Z",
        event: {
          type: "item.completed",
          item: { type: "command_execution", command: `curl -H "Authorization: Bearer ${SECRET}"` },
        },
      },
      {
        observedAt: "2026-01-01T00:00:00.200Z",
        event: { type: "error", message: `key ${SECRET} rejected` },
      },
    ];
    const spans = buildEventSpans(events, context, [SECRET]);
    const serialized = JSON.stringify(spans);
    expect(serialized).not.toContain(SECRET);
  });
});
