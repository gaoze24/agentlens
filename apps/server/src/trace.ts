import { randomUUID } from "node:crypto";
import type { RawCodexEvent, SpanStatus, TraceSpan } from "./types.js";

const MAX_STRING_LENGTH = 4_096;
const SUMMARY_STRING_LENGTH = 256;
const TRUNCATION_SUFFIX = "…[truncated]";

/**
 * Credential shapes worth catching even when the value is not one of the
 * secrets this process was configured with. An Agent can discover a credential
 * inside its own workspace and echo it to stdout, where exact-match redaction
 * against the Ark key would never see it.
 */
const CREDENTIAL_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /Basic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, replacement: "Basic [REDACTED]" },
  // OpenAI-style, GitHub, Slack, Google, and AWS access key IDs.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: "[REDACTED]" },
  { pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/g, replacement: "[REDACTED]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED]" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: "[REDACTED]" },
  { pattern: /\bAIza[A-Za-z0-9_-]{30,}/g, replacement: "[REDACTED]" },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: "[REDACTED]" },
  // PEM private key blocks, including the body.
  {
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED PRIVATE KEY]",
  },
  // key=value assignments for obviously sensitive names.
  {
    pattern:
      /([A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    replacement: "$1$2[REDACTED]",
  },
];

export function redactSecrets(
  value: string,
  secrets: readonly string[],
  maxLength = MAX_STRING_LENGTH,
): string {
  let result = value;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join("[REDACTED]");
  }
  for (const { pattern, replacement } of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  if (result.length > maxLength) {
    result = result.slice(0, maxLength) + TRUNCATION_SUFFIX;
  }
  return result;
}

export type TraceCaptureLevel = "summary" | "full";

/**
 * In `summary` capture, payload strings are clipped hard. A `file_change`
 * event can otherwise carry the whole contents of an edited file into the
 * trace store, which is neither a "safely summarized" record nor something an
 * operator wants persisted by default.
 */
function redactValue(
  value: unknown,
  secrets: readonly string[],
  captureLevel: TraceCaptureLevel,
): unknown {
  const maxLength = captureLevel === "summary" ? SUMMARY_STRING_LENGTH : MAX_STRING_LENGTH;
  if (typeof value === "string") {
    return redactSecrets(value, secrets, maxLength);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets, captureLevel));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = redactValue(nested, secrets, captureLevel);
    }
    return result;
  }
  return value;
}

export function redactAttributes(
  attributes: Record<string, unknown>,
  secrets: readonly string[],
  captureLevel: TraceCaptureLevel = "full",
): Record<string, unknown> {
  return redactValue(attributes, secrets, captureLevel) as Record<string, unknown>;
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
    status: "running",
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
    status: "running",
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
    if (itemType === "error") return "runtime.error";
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
  const item = event.item as Record<string, unknown> | undefined;
  const raw =
    typeof event.message === "string"
      ? event.message
      : typeof event.error === "string"
        ? event.error
        : item && typeof item.message === "string"
          ? item.message
          : JSON.stringify(event);
  return redactSecrets(raw, secrets);
}

/**
 * Cap the number of event spans one Run may contribute. A long Codex turn can
 * emit thousands of JSON events; keeping every one would let a single Run
 * dominate the JSON store. The most recent events are kept because the failing
 * step is normally at the tail, and a notice span records what was dropped.
 */
function truncationSpan(
  context: { runId: string; agentId: string; parentSpanId: string },
  droppedCount: number,
  observedAt: string,
): TraceSpan {
  return {
    id: randomUUID(),
    runId: context.runId,
    agentId: context.agentId,
    parentSpanId: context.parentSpanId,
    category: "trace.truncated",
    name: "trace.truncated",
    status: "ok",
    startedAt: observedAt,
    completedAt: observedAt,
    durationMs: 0,
    attributes: { droppedEventCount: droppedCount },
    errorMessage: null,
  };
}

export function buildEventSpans(
  events: readonly RawCodexEvent[],
  context: { runId: string; agentId: string; parentSpanId: string },
  secrets: readonly string[],
  maxEventSpans = Number.POSITIVE_INFINITY,
  captureLevel: TraceCaptureLevel = "full",
): TraceSpan[] {
  const dropped = Math.max(0, events.length - maxEventSpans);
  const kept = dropped > 0 ? events.slice(dropped) : events;
  const notice =
    dropped > 0
      ? [truncationSpan(context, dropped, events[0]?.observedAt ?? new Date().toISOString())]
      : [];
  return notice.concat(kept.map((raw) => {
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
      attributes: redactAttributes(raw.event, secrets, captureLevel),
      errorMessage: isError ? messageForErrorEvent(raw.event, secrets) : null,
    } satisfies TraceSpan;
  }));
}

/**
 * Retention policy: keep spans for the most recent `maxRuns` Runs and discard
 * the rest. Spans are grouped by Run so a retained trace is never left with
 * half its tree missing.
 */
export function pruneSpans(spans: readonly TraceSpan[], maxRuns: number): TraceSpan[] {
  const latestStartByRun = new Map<string, string>();
  for (const span of spans) {
    const current = latestStartByRun.get(span.runId);
    if (current === undefined || span.startedAt > current) {
      latestStartByRun.set(span.runId, span.startedAt);
    }
  }
  if (latestStartByRun.size <= maxRuns) {
    return [...spans];
  }
  const retained = new Set(
    [...latestStartByRun.entries()]
      .sort((left, right) => right[1].localeCompare(left[1]))
      .slice(0, maxRuns)
      .map(([runId]) => runId),
  );
  return spans.filter((span) => retained.has(span.runId));
}
