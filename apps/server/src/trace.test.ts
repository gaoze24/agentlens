import { describe, expect, it } from "vitest";
import {
  buildEventSpans,
  buildProcessSpan,
  buildRunSpan,
  completeSpan,
  pruneSpans,
  redactAttributes,
  redactSecrets,
} from "./trace.js";
import type { RawCodexEvent } from "./types.js";

const SECRET = "ark-secret-key-do-not-leak";

/** Identifiers every span of a Run carries. */
const IDENTITY = {
  traceId: "trace-1",
  runId: "run-1",
  agentId: "agent-1",
  agentVersion: 1,
  sessionId: "thread-1",
};

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
      ...IDENTITY,
      promptLength: 12,
      promptPreview: "write a cli",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(span.parentSpanId).toBeNull();
    expect(span.category).toBe("orchestration");
    expect(span.status).toBe("running");
    expect(span.completedAt).toBeNull();
  });

  it("links a process span to its parent run span", () => {
    const runSpan = buildRunSpan({
      ...IDENTITY,
      promptLength: 12,
      promptPreview: "write a cli",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const processSpan = buildProcessSpan({
      ...IDENTITY,
      parentSpanId: runSpan.id,
      startedAt: "2026-01-01T00:00:01.000Z",
      sandboxMode: "workspace-write",
      runtimeProvider: "container",
      containerEngine: "docker",
      model: "ep-test",
      modelBaseUrl: "https://ark.example/api/v3",
      runtimeImage: "volc-agent-runtime:local",
      resourceLimits: { cpus: 2, memory: "2g", pids: 256 },
    });
    expect(processSpan.parentSpanId).toBe(runSpan.id);
    expect(processSpan.attributes.containerEngine).toBe("docker");
  });

  it("computes duration and status when a span completes successfully", () => {
    const span = buildRunSpan({
      ...IDENTITY,
      promptLength: 1,
      promptPreview: "x",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const completed = completeSpan(span, "ok", "2026-01-01T00:00:02.500Z");
    expect(completed.status).toBe("ok");
    expect(completed.durationMs).toBe(2_500);
    expect(completed.errorMessage).toBeNull();
  });

  it("marks a cancelled span distinctly from a failed one", () => {
    const span = buildRunSpan({
      ...IDENTITY,
      promptLength: 1,
      promptPreview: "x",
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
  const context = { ...IDENTITY, parentSpanId: "process-1" };

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

  it("downgrades the known model metadata fallback event to a warning", () => {
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
    expect(spans[0]?.category).toBe("runtime.warning");
    expect(spans[0]?.status).toBe("warning");
    expect(spans[0]?.errorMessage).toContain("Model metadata for");
    expect(spans[0]?.errorMessage).not.toContain(SECRET);
  });

  it("keeps other nested item errors as failed spans", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.150Z",
        event: {
          type: "item.completed",
          item: { id: "item_0", type: "error", message: "Tool execution failed." },
        },
      },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans[0]?.category).toBe("runtime.error");
    expect(spans[0]?.status).toBe("error");
  });

  it("categorizes both turn lifecycle events as model turns", () => {
    const events: RawCodexEvent[] = [
      { observedAt: "2026-01-01T00:00:00.100Z", event: { type: "turn.started" } },
      { observedAt: "2026-01-01T00:00:00.200Z", event: { type: "turn.completed" } },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans.map((span) => span.category)).toEqual(["model.turn", "model.turn"]);
  });

  it("pairs item lifecycle events and computes their duration", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.100Z",
        event: { type: "item.started", item: { id: "cmd-1", type: "command_execution" } },
      },
      {
        observedAt: "2026-01-01T00:00:02.600Z",
        event: { type: "item.completed", item: { id: "cmd-1", type: "command_execution" } },
      },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.category).toBe("tool.call");
    expect(spans[0]?.durationMs).toBe(2_500);
  });

  it("marks an item with no completion event as a warning", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.100Z",
        event: { type: "item.started", item: { id: "cmd-1", type: "command_execution" } },
      },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toBe("warning");
    expect(spans[0]?.completedAt).toBeNull();
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

describe("event span capping", () => {
  const context = { ...IDENTITY, parentSpanId: "process-1" };
  const events = (count: number): RawCodexEvent[] =>
    Array.from({ length: count }, (_, index) => ({
      observedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      event: {
        type: "item.completed",
        item: { id: "i" + index, type: "agent_message", text: "m" + index },
      },
    }));

  it("keeps the most recent events and records how many were dropped", () => {
    const spans = buildEventSpans(events(10), context, [], 4);
    expect(spans).toHaveLength(5);
    const notice = spans.find((span) => span.category === "trace.truncated");
    expect(notice?.attributes.droppedEventCount).toBe(6);
    expect(notice?.status).toBe("warning");
    const kept = spans.filter((span) => span.category === "model.message");
    expect(kept).toHaveLength(4);
    expect((kept.at(-1)?.attributes.item as { text: string }).text).toBe("m9");
  });

  it("adds no notice span when the event count is within the cap", () => {
    expect(buildEventSpans(events(3), context, [], 10)).toHaveLength(3);
  });

  it("is uncapped by default", () => {
    expect(buildEventSpans(events(50), context, [])).toHaveLength(50);
  });
});

describe("pruneSpans", () => {
  const spanFor = (runId: string, startedAt: string, parentSpanId: string | null = null) => ({
    id: runId + startedAt,
    traceId: runId,
    runId,
    agentId: "agent-1",
    agentVersion: 1,
    sessionId: null,
    actorType: "agent" as const,
    parentSpanId,
    category: "orchestration",
    name: "run.orchestration",
    status: "ok" as const,
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
    attributes: {},
    errorMessage: null,
  });

  it("returns every span while the Run count is within the limit", () => {
    expect(pruneSpans([spanFor("a", "2026-01-01T00:00:00.000Z")], 5)).toHaveLength(1);
  });

  it("drops the oldest Runs whole rather than truncating a trace mid-tree", () => {
    const spans = [
      spanFor("old", "2026-01-01T00:00:00.000Z"),
      spanFor("old", "2026-01-01T00:00:01.000Z", "p"),
      spanFor("new", "2026-01-02T00:00:00.000Z"),
      spanFor("new", "2026-01-02T00:00:01.000Z", "p"),
    ];
    const pruned = pruneSpans(spans, 1);
    expect(pruned).toHaveLength(2);
    expect(pruned.every((span) => span.runId === "new")).toBe(true);
  });
});

describe("credential pattern redaction", () => {
  const leaked: [string, string][] = [
    ["OpenAI-style key", "sk-abcdefghijklmnopqrstuvwxyz012345"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub fine-grained token", "github_pat_abcdefghijklmnopqrstuv0123456789"],
    ["Slack token", "xoxb-1234567890-abcdefghijkl"],
    ["Google API key", "AIzaSyA1234567890abcdefghijklmnopqrstuvw"],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
  ];

  it.each(leaked)("redacts a %s the process was never configured with", (_label, secret) => {
    const result = redactSecrets("the agent printed " + secret + " to stdout", []);
    expect(result).not.toContain(secret);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts a PEM private key block including its body", () => {
    const key = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAxGxQ0000000000000000000000000",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const result = redactSecrets("found a key:\n" + key, []);
    expect(result).not.toContain("MIIEowIBAAKCAQEA");
    expect(result).toContain("[REDACTED PRIVATE KEY]");
  });

  it("redacts the value of a sensitive assignment but keeps its name", () => {
    const result = redactSecrets('DB_PASSWORD="hunter2" and api_key=abcd1234', []);
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("abcd1234");
    expect(result).toContain("PASSWORD");
    expect(result).toContain("api_key");
  });

  it("redacts a Basic authorization header", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==", [])).toBe(
      "Authorization: Basic [REDACTED]",
    );
  });

  it("leaves ordinary prose and command output untouched", () => {
    const prose = "Ran the test suite: 3 assertions passed in 1.2s.";
    expect(redactSecrets(prose, [])).toBe(prose);
  });

  it("still lets the known model metadata fallback message through for classification", () => {
    // buildEventSpan matches this AFTER redaction to downgrade it to a
    // warning, so redaction must not disturb the phrase it keys on.
    const message = redactSecrets("Model metadata for ep-abc123 not found.", []);
    expect(message).toBe("Model metadata for ep-abc123 not found.");
  });

  it("redacts a credential the Agent echoes into a tool call payload", () => {
    const spanContext = { ...IDENTITY, parentSpanId: "process-1" };
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.100Z",
        event: {
          type: "item.completed",
          item: {
            id: "i1",
            type: "command_execution",
            command: "cat .env",
            aggregated_output: "AWS_KEY=AKIAIOSFODNN7EXAMPLE\nOPENAI=sk-abcdefghijklmnopqrstuvwxyz012345",
          },
        },
      },
    ];
    const serialized = JSON.stringify(buildEventSpans(events, spanContext, []));
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });
});
