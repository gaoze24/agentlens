import { randomUUID } from "node:crypto";
import type {
  ActorType,
  PolicyDecision,
  RawCodexEvent,
  SpanStatus,
  TraceSpan,
} from "./types.js";

const MAX_STRING_LENGTH = 4_096;
const TRUNCATION_SUFFIX = "…[truncated]";
const MODEL_METADATA_FALLBACK_PATTERN =
  /Model metadata for .+ not found\b/i;
const SENSITIVE_KEY =
  /^[A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)$/i;

/**
 * Credential shapes worth catching even when the value is not one of the
 * secrets this process was configured with. An Agent can discover a credential
 * inside its own workspace and echo it to stdout, where exact-match redaction
 * against the Ark key would never see it -- and the audit bundle is designed
 * to leave the machine, so a miss here is a disclosure rather than a local
 * blemish.
 */
const CREDENTIAL_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /Basic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, replacement: "Basic [REDACTED]" },
  // OpenAI-style, GitHub, Slack, Google, and AWS access key ids.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: "[REDACTED]" },
  { pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/g, replacement: "[REDACTED]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED]" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: "[REDACTED]" },
  { pattern: /\bAIza[A-Za-z0-9_-]{30,}/g, replacement: "[REDACTED]" },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: "[REDACTED]" },
  // PEM private key blocks, body included.
  {
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED PRIVATE KEY]",
  },
  // JSON fragments embedded in prose (including escaped quotes in values).
  {
    pattern:
      /(["'])([A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token))\1(\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\d+(?:\.\d+)?|true|false)/gi,
    replacement: '$1$2$1$3"[REDACTED]"',
  },
  // Sensitive assignments: the name is kept, the value is not.
  {
    pattern:
      /([A-Za-z0-9_.-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token))(\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&"'{}]+)/gi,
    replacement: "$1$2[REDACTED]",
  },
];

function truncateRedacted(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? value.slice(0, MAX_STRING_LENGTH) + TRUNCATION_SUFFIX
    : value;
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  let result = value;
  // Tool output is often JSON encoded inside a string. Parse before replacing
  // text so escaped keys and structured credential values are handled too.
  if (/^\s*[\[{]/.test(value)) {
    try {
      return truncateRedacted(JSON.stringify(redactValue(JSON.parse(value), secrets)));
    } catch {
      // Partial JSON and ordinary prose still get the pattern-based pass.
    }
  }
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join("[REDACTED]");
  }
  for (const { pattern, replacement } of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return truncateRedacted(result);
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
      Object.defineProperty(result, redactSecrets(key, secrets), {
        value: SENSITIVE_KEY.test(key) && nested !== null
          ? "[REDACTED]"
          : redactValue(nested, secrets),
        enumerable: true,
        configurable: true,
        writable: true,
      });
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

/** Close an interrupted step at the Run boundary, not when someone views it. */
export function closeUnfinishedSpan(
  span: TraceSpan,
  completedAt: string,
  status: SpanStatus,
  attributes: Record<string, unknown> = {},
): TraceSpan {
  if (span.completedAt && span.status !== "running") return span;
  // Clock skew must not produce negative duration or an invalid export.
  const end = new Date(Math.max(Date.parse(span.startedAt), Date.parse(completedAt))).toISOString();
  return completeSpan(span, status, end, span.errorMessage, {
    completionSource: "run-end",
    ...attributes,
  });
}

/** Identifiers every span of a Run carries, so a span stands alone. */
export interface SpanIdentity {
  traceId: string;
  runId: string;
  agentId: string;
  agentVersion: number;
  sessionId: string | null;
}

export interface BuildRunSpanInput extends SpanIdentity {
  promptLength: number;
  promptPreview: string;
  startedAt: string;
}

export function buildRunSpan(input: BuildRunSpanInput): TraceSpan {
  return {
    id: randomUUID(),
    traceId: input.traceId,
    runId: input.runId,
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    sessionId: input.sessionId,
    // The Run exists because a person asked for it; everything beneath this
    // span is the Agent acting on their behalf.
    actorType: "human",
    parentSpanId: null,
    category: "orchestration",
    name: "run.orchestration",
    status: "running",
    startedAt: input.startedAt,
    completedAt: null,
    durationMs: null,
    attributes: {
      promptLength: input.promptLength,
      promptPreview: input.promptPreview,
    },
    errorMessage: null,
  };
}

export interface BuildProcessSpanInput extends SpanIdentity {
  parentSpanId: string;
  startedAt: string;
  sandboxMode: string;
  runtimeProvider: string;
  containerEngine: string | null;
  /** Model and infrastructure metadata needed to diagnose the Run. */
  model: string;
  modelBaseUrl: string;
  runtimeImage: string | null;
  resourceLimits: Record<string, unknown> | null;
}

export function buildProcessSpan(input: BuildProcessSpanInput): TraceSpan {
  return {
    id: randomUUID(),
    traceId: input.traceId,
    runId: input.runId,
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    sessionId: input.sessionId,
    actorType: "agent",
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
      // Never the API key: only which model answered and where it lives.
      model: input.model,
      modelBaseUrl: input.modelBaseUrl,
      ...(input.containerEngine ? { containerEngine: input.containerEngine } : {}),
      ...(input.runtimeImage ? { runtimeImage: input.runtimeImage } : {}),
      ...(input.resourceLimits ? { resourceLimits: input.resourceLimits } : {}),
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
  if (type === "turn.started" || type === "turn.completed") return "model.turn";
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

function itemIdForEvent(event: Record<string, unknown>): string | null {
  const item = event.item as Record<string, unknown> | undefined;
  return item && typeof item.id === "string" ? item.id : null;
}

function buildEventSpan(
  raw: RawCodexEvent,
  context: SpanIdentity & { parentSpanId: string },
  secrets: readonly string[],
  startedAt = raw.observedAt,
): TraceSpan {
  let category = categoryForEvent(raw.event);
  const errorMessage = category === "runtime.error"
    ? messageForErrorEvent(raw.event, secrets)
    : null;
  const isWarning = errorMessage !== null && MODEL_METADATA_FALLBACK_PATTERN.test(errorMessage);
  if (isWarning) category = "runtime.warning";
  const completedAt = raw.observedAt;
  return {
    id: randomUUID(),
    traceId: context.traceId,
    runId: context.runId,
    agentId: context.agentId,
    agentVersion: context.agentVersion,
    sessionId: context.sessionId,
    actorType: "agent" as const,
    parentSpanId: context.parentSpanId,
    category,
    name: nameForEvent(raw.event, category),
    status: isWarning ? "warning" : errorMessage !== null ? "error" : "ok",
    startedAt,
    completedAt,
    durationMs: durationBetween(startedAt, completedAt),
    attributes: redactAttributes(raw.event, secrets),
    errorMessage,
  };
}

/**
 * Records that older events were dropped, so a truncated trace says so rather
 * than silently starting in the middle.
 */
function truncationSpan(
  context: SpanIdentity & { parentSpanId: string },
  droppedCount: number,
  observedAt: string,
): TraceSpan {
  return {
    id: randomUUID(),
    traceId: context.traceId,
    runId: context.runId,
    agentId: context.agentId,
    agentVersion: context.agentVersion,
    sessionId: context.sessionId,
    actorType: "agent" as const,
    parentSpanId: context.parentSpanId,
    category: "trace.truncated",
    name: "trace.truncated",
    status: "warning",
    startedAt: observedAt,
    completedAt: observedAt,
    durationMs: 0,
    attributes: { droppedEventCount: droppedCount },
    errorMessage:
      droppedCount + " earlier events exceeded TRACE_MAX_EVENT_SPANS_PER_RUN and were dropped.",
  };
}

export function buildEventSpans(
  events: readonly RawCodexEvent[],
  context: SpanIdentity & { parentSpanId: string },
  secrets: readonly string[],
  maxEventSpans = Number.POSITIVE_INFINITY,
  completion?: { completedAt: string; status: SpanStatus; attributes?: Record<string, unknown> },
): TraceSpan[] {
  // Keep the most recent events: a failing step is normally at the tail. An
  // item.completed whose item.started was dropped degrades to a point span.
  const dropped = Math.max(0, events.length - maxEventSpans);
  const kept = dropped > 0 ? events.slice(dropped) : events;
  const spans: TraceSpan[] =
    dropped > 0
      ? [truncationSpan(context, dropped, events[0]?.observedAt ?? new Date().toISOString())]
      : [];
  const pendingItems = new Map<string, RawCodexEvent>();

  for (const raw of kept) {
    const type = raw.event.type;
    const itemId = itemIdForEvent(raw.event);
    if (type === "item.started" && itemId) {
      pendingItems.set(itemId, raw);
      continue;
    }
    if (type === "item.completed" && itemId) {
      const started = pendingItems.get(itemId);
      if (started) pendingItems.delete(itemId);
      spans.push(buildEventSpan(raw, context, secrets, started?.observedAt));
      continue;
    }
    spans.push(buildEventSpan(raw, context, secrets));
  }

  for (const pending of pendingItems.values()) {
    const category = categoryForEvent(pending.event);
    spans.push({
      id: randomUUID(),
      traceId: context.traceId,
      runId: context.runId,
      agentId: context.agentId,
      agentVersion: context.agentVersion,
      sessionId: context.sessionId,
      actorType: "agent" as const,
      parentSpanId: context.parentSpanId,
      category,
      name: nameForEvent(pending.event, category),
      status: "warning",
      startedAt: pending.observedAt,
      completedAt: null,
      durationMs: null,
      attributes: redactAttributes(pending.event, secrets),
      errorMessage: "Event started but no matching item.completed event was observed.",
    });
  }

  return spans
    .map((span) => completion
      ? closeUnfinishedSpan(span, completion.completedAt, completion.status, completion.attributes)
      : span)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/**
 * Retention policy: keep spans for the most recent `maxRuns` Runs and discard
 * older Runs whole, so a retained trace is never left with half its tree
 * missing. Without this the JSON store grows without bound, and every mutation
 * rewrites the entire file.
 */
export function pruneSpans(spans: readonly TraceSpan[], maxRuns: number): TraceSpan[] {
  const latestStartByRun = new Map<string, string>();
  for (const span of spans) {
    const current = latestStartByRun.get(span.runId);
    if (current === undefined || span.startedAt > current) {
      latestStartByRun.set(span.runId, span.startedAt);
    }
  }
  if (latestStartByRun.size <= maxRuns) return [...spans];
  const retained = new Set(
    [...latestStartByRun.entries()]
      .sort((left, right) => right[1].localeCompare(left[1]))
      .slice(0, maxRuns)
      .map(([runId]) => runId),
  );
  return spans.filter((span) => retained.has(span.runId));
}

/**
 * A policy decision is a first-class span: the trace should show that the check
 * ran and what it concluded, not only the actions that survived it.
 */
export function buildPolicySpan(
  decision: PolicyDecision,
  context: SpanIdentity & { parentSpanId: string },
  secrets: readonly string[],
  observedAt: string,
): TraceSpan {
  const denied = decision.decision === "deny";
  return {
    id: randomUUID(),
    traceId: context.traceId,
    runId: context.runId,
    agentId: context.agentId,
    agentVersion: context.agentVersion,
    sessionId: context.sessionId,
    // The platform decides, not the Agent and not the operator.
    actorType: "system",
    parentSpanId: context.parentSpanId,
    category: "policy.decision",
    name: "policy.decision:" + decision.decision,
    status: denied ? "error" : "ok",
    startedAt: observedAt,
    completedAt: observedAt,
    durationMs: 0,
    attributes: {
      decision: decision.decision,
      ruleId: decision.ruleId,
      reason: decision.reason,
      protectedAsset: decision.protectedAsset,
      command: redactSecrets(decision.command, secrets),
    },
    errorMessage: denied
      ? "Denied by policy " + decision.ruleId + ": " + decision.reason
      : null,
  };
}

/**
 * A span for an item Codex has started but not finished. It is written while
 * the Run is still executing, so the browser can show a step the moment it
 * begins rather than only once the turn ends.
 */
function openEventSpan(
  raw: RawCodexEvent,
  context: SpanIdentity & { parentSpanId: string },
  secrets: readonly string[],
): TraceSpan {
  const category = categoryForEvent(raw.event);
  return {
    id: randomUUID(),
    traceId: context.traceId,
    runId: context.runId,
    agentId: context.agentId,
    agentVersion: context.agentVersion,
    sessionId: context.sessionId,
    actorType: "agent",
    parentSpanId: context.parentSpanId,
    category,
    name: nameForEvent(raw.event, category),
    status: "running",
    startedAt: raw.observedAt,
    completedAt: null,
    durationMs: null,
    attributes: redactAttributes(raw.event, secrets),
    errorMessage: null,
  };
}

/** Spans to insert, and spans to replace by id, after one observed event. */
export interface LiveSpanUpdate {
  appended: TraceSpan[];
  updated: TraceSpan[];
}

const NO_LIVE_SPANS: LiveSpanUpdate = { appended: [], updated: [] };

/**
 * The streaming counterpart to {@link buildEventSpans}. `buildEventSpans` sees
 * a whole Run at once and can pair `item.started` with `item.completed` by
 * looking ahead; a live trace has no lookahead, so an started item is written
 * open and closed in place when its completion arrives.
 *
 * Past `maxEventSpans` this stops emitting rather than dropping the oldest
 * spans: the live view is a tail the operator is already watching, and the
 * authoritative set written when the Run ends applies the real truncation
 * policy, including its notice span.
 */
export class LiveTraceWriter {
  private readonly openByItemId = new Map<string, TraceSpan>();
  private emitted = 0;

  constructor(
    private readonly context: SpanIdentity & { parentSpanId: string },
    private readonly secrets: readonly string[],
    private readonly maxEventSpans: number = Number.POSITIVE_INFINITY,
  ) {}

  ingest(raw: RawCodexEvent): LiveSpanUpdate {
    const type = raw.event.type;
    const itemId = itemIdForEvent(raw.event);

    if (type === "item.started" && itemId) {
      if (!this.reserve()) return NO_LIVE_SPANS;
      const span = openEventSpan(raw, this.context, this.secrets);
      this.openByItemId.set(itemId, span);
      return { appended: [span], updated: [] };
    }

    if (type === "item.completed" && itemId) {
      const open = this.openByItemId.get(itemId);
      if (open) {
        this.openByItemId.delete(itemId);
        // Same span id and start time, so the row the operator is watching is
        // closed in place instead of being duplicated.
        const closed = buildEventSpan(raw, this.context, this.secrets, open.startedAt);
        return { appended: [], updated: [{ ...closed, id: open.id }] };
      }
    }

    if (!this.reserve()) return NO_LIVE_SPANS;
    return { appended: [buildEventSpan(raw, this.context, this.secrets)], updated: [] };
  }

  private reserve(): boolean {
    if (this.emitted >= this.maxEventSpans) return false;
    this.emitted += 1;
    return true;
  }
}
