import { randomUUID } from "node:crypto";
import type { RawCodexEvent, SpanStatus, TraceSpan } from "./types.js";

const MAX_STRING_LENGTH = 4_096;
const TRUNCATION_SUFFIX = "…[truncated]";
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function redactSecrets(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join("[REDACTED]");
  }
  result = result.replace(BEARER_PATTERN, "Bearer [REDACTED]");
  if (result.length > MAX_STRING_LENGTH) {
    result = result.slice(0, MAX_STRING_LENGTH) + TRUNCATION_SUFFIX;
  }
  return result;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = redactValue(nested, secrets);
    }
    return result;
  }
  return value;
}

export function redactAttributes(
  attributes: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  return redactValue(attributes, secrets) as Record<string, unknown>;
}

function durationBetween(startedAt: string, completedAt: string): number | null {
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    return null;
  }
  return completedMs - startedMs;
}

export function completeSpan(
  span: TraceSpan,
  status: SpanStatus,
  completedAt: string,
  errorMessage: string | null = null,
  extraAttributes: Record<string, unknown> = {},
): TraceSpan {
  return {
    ...span,
    status,
    completedAt,
    durationMs: durationBetween(span.startedAt, completedAt),
    errorMessage,
    attributes: { ...span.attributes, ...extraAttributes },
  };
}

export interface BuildRunSpanInput {
  runId: string;
  agentId: string;
  promptLength: number;
  startedAt: string;
}

export function buildRunSpan(input: BuildRunSpanInput): TraceSpan {
  return {
    id: randomUUID(),
    runId: input.runId,
    agentId: input.agentId,
    parentSpanId: null,
    category: "orchestration",
    name: "run.orchestration",
    status: "ok",
    startedAt: input.startedAt,
    completedAt: null,
    durationMs: null,
    attributes: { promptLength: input.promptLength },
    errorMessage: null,
  };
}

export interface BuildProcessSpanInput {
  runId: string;
  agentId: string;
  parentSpanId: string;
  startedAt: string;
  sandboxMode: string;
  runtimeProvider: string;
  containerEngine: string | null;
}

export function buildProcessSpan(input: BuildProcessSpanInput): TraceSpan {
  return {
    id: randomUUID(),
    runId: input.runId,
    agentId: input.agentId,
    parentSpanId: input.parentSpanId,
    category: "runtime.process",
    name:
      input.runtimeProvider === "container" ? "runtime.container" : "runtime.local-process",
    status: "ok",
    startedAt: input.startedAt,
    completedAt: null,
    durationMs: null,
    attributes: {
      sandboxMode: input.sandboxMode,
      runtimeProvider: input.runtimeProvider,
      ...(input.containerEngine ? { containerEngine: input.containerEngine } : {}),
    },
    errorMessage: null,
  };
}

function categoryForEvent(event: Record<string, unknown>): string {
  const type = typeof event.type === "string" ? event.type : "unknown";
  if (type === "item.completed" || type === "item.started") {
    const item = event.item as Record<string, unknown> | undefined;
    const itemType = item && typeof item.type === "string" ? item.type : "unknown";
    if (itemType === "agent_message") return "model.message";
    if (itemType === "reasoning") return "model.reasoning";
    if (itemType === "command_execution" || itemType === "file_change") return "tool.call";
    return "unknown." + itemType;
  }
  if (type === "turn.completed") return "model.turn";
  if (type === "thread.started") return "runtime.thread";
  if (type === "error") return "runtime.error";
  return "unknown." + type;
}

function nameForEvent(event: Record<string, unknown>, category: string): string {
  if (typeof event.type === "string" && event.type.startsWith("item.")) {
    const item = event.item as Record<string, unknown> | undefined;
    if (item && typeof item.type === "string") {
      return category + ":" + item.type;
    }
  }
  return category;
}

function messageForErrorEvent(event: Record<string, unknown>, secrets: readonly string[]): string {
  const raw =
    typeof event.message === "string"
      ? event.message
      : typeof event.error === "string"
        ? event.error
        : JSON.stringify(event);
  return redactSecrets(raw, secrets);
}

export function buildEventSpans(
  events: readonly RawCodexEvent[],
  context: { runId: string; agentId: string; parentSpanId: string },
  secrets: readonly string[],
): TraceSpan[] {
  return events.map((raw) => {
    const category = categoryForEvent(raw.event);
    const isError = category === "runtime.error";
    return {
      id: randomUUID(),
      runId: context.runId,
      agentId: context.agentId,
      parentSpanId: context.parentSpanId,
      category,
      name: nameForEvent(raw.event, category),
      status: isError ? "error" : "ok",
      startedAt: raw.observedAt,
      completedAt: raw.observedAt,
      durationMs: 0,
      attributes: redactAttributes(raw.event, secrets),
      errorMessage: isError ? messageForErrorEvent(raw.event, secrets) : null,
    } satisfies TraceSpan;
  });
}
