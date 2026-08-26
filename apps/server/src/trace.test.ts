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
    expect(span.status).toBe("running");
    expect(span.completedAt).toBeNull();
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

describe("event span capping", () => {
  const context = { runId: "run-1", agentId: "agent-1", parentSpanId: "process-1" };

  it("keeps the most recent events and records how many were dropped", () => {
    const events: RawCodexEvent[] = Array.from({ length: 10 }, (_, index) => ({
      observedAt: `2026-01-01T00:00:0${index}.000Z`,
      event: { type: "item.completed", item: { type: "agent_message", text: "m" + index } },
    }));
    const spans = buildEventSpans(events, context, [], 4);
    expect(spans).toHaveLength(5);
    expect(spans[0]?.category).toBe("trace.truncated");
    expect(spans[0]?.attributes.droppedEventCount).toBe(6);
    const lastAttributes = spans.at(-1)?.attributes as { item: { text: string } };
    expect(lastAttributes.item.text).toBe("m9");
  });

  it("adds no notice span when the event count is within the cap", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.000Z",
        event: { type: "item.completed", item: { type: "agent_message", text: "hi" } },
      },
    ];
    expect(buildEventSpans(events, context, [], 4)).toHaveLength(1);
  });
});

describe("pruneSpans", () => {
  const spanForRun = (runId: string, startedAt: string) => ({
    id: runId + ":" + startedAt,
    runId,
    agentId: "agent-1",
    parentSpanId: null,
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
    const spans = [spanForRun("a", "2026-01-01T00:00:00.000Z")];
    expect(pruneSpans(spans, 2)).toHaveLength(1);
  });

  it("drops the oldest Runs whole rather than truncating a trace mid-tree", () => {
    const spans = [
      spanForRun("old", "2026-01-01T00:00:00.000Z"),
      { ...spanForRun("old", "2026-01-01T00:00:01.000Z"), parentSpanId: "x" },
      spanForRun("new", "2026-01-02T00:00:00.000Z"),
      { ...spanForRun("new", "2026-01-02T00:00:01.000Z"), parentSpanId: "y" },
    ];
    const pruned = pruneSpans(spans, 1);
    expect(pruned).toHaveLength(2);
    expect(pruned.every((span) => span.runId === "new")).toBe(true);
  });
});

describe("credential pattern redaction", () => {
  const cases: [string, string][] = [
    ["OpenAI-style key", "sk-abcdefghijklmnopqrstuvwxyz012345"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub fine-grained token", "github_pat_abcdefghijklmnopqrstuv0123456789"],
    ["Slack token", "xoxb-1234567890-abcdefghijkl"],
    ["Google API key", "AIzaSyA1234567890abcdefghijklmnopqrstuvw"],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
  ];

  it.each(cases)("redacts a leaked %s the process was never told about", (_label, secret) => {
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
    const result = redactSecrets("found key:\n" + key, []);
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
    const result = redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==", []);
    expect(result).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(result).toBe("Authorization: Basic [REDACTED]");
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "Ran the test suite and 3 assertions passed.";
    expect(redactSecrets(prose, [])).toBe(prose);
  });
});

describe("capture level", () => {
  const longFile = "x".repeat(3_000);

  it("clips payload strings hard in summary capture", () => {
    const result = redactAttributes({ item: { contents: longFile } }, [], "summary");
    const contents = (result.item as { contents: string }).contents;
    expect(contents.length).toBeLessThan(400);
    expect(contents.endsWith("…[truncated]")).toBe(true);
  });

  it("keeps the larger payload budget in full capture", () => {
    const result = redactAttributes({ item: { contents: longFile } }, [], "full");
    expect((result.item as { contents: string }).contents).toHaveLength(3_000);
  });

  it("still redacts secrets in summary capture", () => {
    const result = redactAttributes(
      { item: { command: "curl -H 'Authorization: Bearer " + SECRET + "'" } },
      [SECRET],
      "summary",
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("item.started / item.completed pairing", () => {
  const context = { runId: "run-1", agentId: "agent-1", parentSpanId: "process-1" };

  it("collapses a started/completed pair into one span with a real duration", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.000Z",
        event: { type: "item.started", item: { id: "i1", type: "command_execution" } },
      },
      {
        observedAt: "2026-01-01T00:00:02.500Z",
        event: {
          type: "item.completed",
          item: { id: "i1", type: "command_execution", command: "npm test", exit_code: 0 },
        },
      },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.category).toBe("tool.call");
    expect(spans[0]?.status).toBe("ok");
    expect(spans[0]?.durationMs).toBe(2_500);
    expect(spans[0]?.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(spans[0]?.completedAt).toBe("2026-01-01T00:00:02.500Z");
    // The payload comes from the completed event, which carries the detail.
    expect((spans[0]?.attributes.item as { command: string }).command).toBe("npm test");
  });

  it("leaves an item that has started but not completed open and running", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.000Z",
        event: { type: "item.started", item: { id: "i1", type: "command_execution" } },
      },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toBe("running");
    expect(spans[0]?.completedAt).toBeNull();
    expect(spans[0]?.durationMs).toBeNull();
  });

  it("marks a paired item that completed as an error as failed", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.000Z",
        event: { type: "item.started", item: { id: "i1", type: "command_execution" } },
      },
      {
        observedAt: "2026-01-01T00:00:01.000Z",
        event: { type: "item.completed", item: { id: "i1", type: "error", message: "boom" } },
      },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toBe("error");
    expect(spans[0]?.errorMessage).toContain("boom");
  });

  it("still emits a point span for a completed item that never announced a start", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:01.000Z",
        event: { type: "item.completed", item: { id: "i9", type: "agent_message", text: "hi" } },
      },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toBe("ok");
    expect(spans[0]?.durationMs).toBe(0);
  });

  it("keeps concurrent items apart", () => {
    const events: RawCodexEvent[] = [
      {
        observedAt: "2026-01-01T00:00:00.000Z",
        event: { type: "item.started", item: { id: "a", type: "command_execution" } },
      },
      {
        observedAt: "2026-01-01T00:00:00.500Z",
        event: { type: "item.started", item: { id: "b", type: "command_execution" } },
      },
      {
        observedAt: "2026-01-01T00:00:01.000Z",
        event: { type: "item.completed", item: { id: "b", type: "command_execution" } },
      },
    ];
    const spans = buildEventSpans(events, context, []);
    expect(spans).toHaveLength(2);
    const [first, second] = spans;
    expect(first?.status).toBe("running");
    expect(second?.status).toBe("ok");
    expect(second?.durationMs).toBe(500);
  });
});
