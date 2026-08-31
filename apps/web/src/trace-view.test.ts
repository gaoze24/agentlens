import { describe, expect, it } from "vitest";
import {
  compareDirection,
  filterTraceSpans,
  formatCost,
  isTerminal,
  plural,
  shortId,
  spanBarGeometry,
  spanDurationMs,
  traceWindow,
} from "./trace-view";
import type { TraceSpan } from "./types";

const T0 = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-01-01T00:00:10.000Z");

function span(overrides: Partial<TraceSpan> & Pick<TraceSpan, "id">): TraceSpan {
  return {
    traceId: "trace-1",
    runId: "run-1",
    agentId: "agent-1",
    agentVersion: 1,
    sessionId: "thread-1",
    actorType: "agent",
    parentSpanId: null,
    category: "tool.call",
    name: "tool.call:command_execution",
    status: "ok",
    startedAt: T0,
    completedAt: "2026-01-01T00:00:02.000Z",
    durationMs: 2_000,
    attributes: {},
    errorMessage: null,
    ...overrides,
  };
}

describe("shortId", () => {
  it("truncates an identifier", () => {
    expect(shortId("0123456789abcdef")).toBe("01234567");
  });

  it("survives a span written without one", () => {
    // Regression: a fixture span with no traceId used to throw inside the span
    // detail, which unmounted React and blanked the whole Playground.
    expect(shortId(undefined)).toBe("—");
    expect(shortId(null)).toBe("—");
    expect(shortId("")).toBe("—");
  });
});

describe("isTerminal", () => {
  it("separates the Runs that can still change from the ones that cannot", () => {
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });
});

describe("filterTraceSpans", () => {
  const root = span({ id: "root", category: "orchestration", parentSpanId: null });
  const process = span({ id: "process", category: "runtime.process", parentSpanId: "root" });
  const tool = span({ id: "tool", category: "tool.call", parentSpanId: "process" });
  const failure = span({
    id: "failure",
    category: "runtime.error",
    status: "error",
    parentSpanId: "process",
  });
  const policy = span({
    id: "policy",
    category: "policy.decision",
    actorType: "system",
    parentSpanId: "process",
  });
  const all = [root, process, tool, failure, policy];

  it("keeps every ancestor so the filtered tree is still connected", () => {
    const ids = filterTraceSpans(all, "error").map((item) => item.id);
    expect(ids).toEqual(["root", "process", "failure"]);
  });

  it("isolates tool and policy categories", () => {
    expect(filterTraceSpans(all, "tool").map((item) => item.id)).toEqual([
      "root",
      "process",
      "tool",
    ]);
    expect(filterTraceSpans(all, "policy").map((item) => item.id)).toEqual([
      "root",
      "process",
      "policy",
    ]);
  });

  it("returns the spans untouched for 'all'", () => {
    expect(filterTraceSpans(all, "all")).toEqual(all);
  });

  it("terminates on a parent cycle rather than hanging the panel", () => {
    const left = span({ id: "left", parentSpanId: "right", status: "error" });
    const right = span({ id: "right", parentSpanId: "left" });
    expect(filterTraceSpans([left, right], "error").map((item) => item.id)).toEqual([
      "left",
      "right",
    ]);
  });
});

describe("timeline geometry", () => {
  it("spans the whole Run, drawing an open span up to the present", () => {
    const window = traceWindow(
      [
        span({ id: "a", startedAt: T0, completedAt: "2026-01-01T00:00:02.000Z" }),
        span({ id: "b", startedAt: "2026-01-01T00:00:03.000Z", completedAt: null, status: "running", durationMs: null }),
      ],
      NOW,
    );
    expect(window).toEqual({ start: Date.parse(T0), end: NOW });
  });

  it("never produces a zero-width axis to divide by", () => {
    const instant = span({ id: "a", startedAt: T0, completedAt: T0, durationMs: 0 });
    const window = traceWindow([instant], NOW);
    expect(window!.end - window!.start).toBeGreaterThan(0);
  });

  it("has no window when there are no spans", () => {
    expect(traceWindow([], NOW)).toBeNull();
  });

  it("places a bar proportionally within the axis", () => {
    const window = { start: Date.parse(T0), end: Date.parse(T0) + 10_000 };
    const geometry = spanBarGeometry(
      span({
        id: "a",
        startedAt: "2026-01-01T00:00:02.000Z",
        completedAt: "2026-01-01T00:00:07.000Z",
      }),
      window,
      NOW,
    );
    expect(geometry).toEqual({ offset: 20, width: 50 });
  });

  it("keeps an instantaneous span visible and inside the axis", () => {
    const window = { start: Date.parse(T0), end: Date.parse(T0) + 10_000 };
    const geometry = spanBarGeometry(
      span({ id: "a", startedAt: T0, completedAt: T0, durationMs: 0 }),
      window,
      NOW,
    )!;
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.offset + geometry.width).toBeLessThanOrEqual(100);
  });

  it("reports the elapsed time of a step that is still running", () => {
    const running = span({
      id: "a",
      startedAt: "2026-01-01T00:00:06.000Z",
      completedAt: null,
      durationMs: null,
      status: "running",
    });
    expect(spanDurationMs(running, NOW)).toBe(4_000);
  });

  it("reports no duration for a span that ended without one", () => {
    const orphan = span({ id: "a", completedAt: null, durationMs: null, status: "warning" });
    expect(spanDurationMs(orphan, NOW)).toBeNull();
  });

  it.each(["warning", "error", "cancelled", "ok"] as const)(
    "does not stretch an old %s step to the time of viewing",
    (status) => {
      const orphan = span({ id: "old", completedAt: null, durationMs: null, status });
      const finished = span({ id: "finished" });
      expect(traceWindow([orphan, finished], NOW + 86_400_000)).toEqual({
        start: Date.parse(T0), end: Date.parse(T0) + 2_000,
      });
    },
  );

  it("uses a recorded terminal duration when its end timestamp is missing", () => {
    const old = span({ id: "old", completedAt: null, durationMs: 3_000, status: "warning" });
    expect(traceWindow([old], NOW)).toEqual({ start: Date.parse(T0), end: Date.parse(T0) + 3_000 });
  });
});

describe("formatCost", () => {
  const rates = {
    currency: "USD",
    inputPerMillion: 1,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 3,
    billedInputTokens: 80,
    cachedInputTokens: 40,
    outputTokens: 30,
  };

  it("says so when nothing is priced", () => {
    expect(formatCost(null)).toBe("Not priced");
  });

  it("keeps a sub-cent Run from rounding away to zero", () => {
    expect(formatCost({ ...rates, estimatedTotal: 0.00018 })).toBe("0.00018 USD");
  });

  it("uses ordinary currency precision once the Run costs real money", () => {
    expect(formatCost({ ...rates, estimatedTotal: 1.239 })).toBe("1.24 USD");
  });
});

describe("compareDirection", () => {
  it("colours a delta only where lower is unambiguously better", () => {
    expect(compareDirection(-500, true)).toBe("better");
    expect(compareDirection(500, true)).toBe("worse");
    // More output tokens is neither good nor bad.
    expect(compareDirection(500, undefined)).toBe("flat");
    expect(compareDirection(0, true)).toBe("flat");
    expect(compareDirection(null, true)).toBe("flat");
  });
});

describe("plural", () => {
  it("agrees with its count", () => {
    expect(plural(1, "warning")).toBe("1 warning");
    expect(plural(0, "warning")).toBe("0 warnings");
    expect(plural(3, "model turn")).toBe("3 model turns");
  });
});
