/**
 * The pure view logic behind the trace panel: tree building, filtering,
 * timeline geometry, and formatting.
 *
 * It lives outside the components so it can be tested without a DOM. Every
 * function here reads spans that came off disk, so each one tolerates a span
 * that is missing a field rather than assuming the shape it would like.
 */
import type { AgentRun, AuditCost, TraceSpan } from "./types";

export const TERMINAL_RUN_STATUSES: ReadonlyArray<AgentRun["status"]> = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminal(status: AgentRun["status"]): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Span identity is rendered from data on disk, which can predate a field or be
 * written by a fixture. Truncating it blindly is how a panel takes the whole
 * Playground down with it.
 */
export function shortId(value: string | null | undefined): string {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 8) : "—";
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs < 1_000) return durationMs + " ms";
  return (durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0) + " s";
}

export function formatCost(cost: AuditCost | null): string {
  if (!cost) return "Not priced";
  // Sub-cent Runs are the normal case here, so a currency formatter's two
  // decimals would round almost every demo Run to zero.
  const value =
    cost.estimatedTotal >= 0.01
      ? cost.estimatedTotal.toFixed(2)
      : cost.estimatedTotal.toFixed(5);
  return value + " " + cost.currency;
}

export function runDurationMs(run: AgentRun): number | null {
  if (!run.startedAt || !run.completedAt) return null;
  const durationMs = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}

export function formatRunDuration(run: AgentRun): string {
  if (!run.startedAt) return run.status === "queued" ? "Queued" : "—";
  if (!run.completedAt) return "Running";
  return formatDuration(runDurationMs(run));
}

export function runTokens(run: AgentRun): number {
  return (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);
}

export function formatRunUsage(run: AgentRun): string {
  const total = runTokens(run);
  return total ? total.toLocaleString() + " tokens" : "No usage";
}

export function buildSpanChildren(spans: TraceSpan[]): Map<string | null, TraceSpan[]> {
  const map = new Map<string | null, TraceSpan[]>();
  for (const span of spans) {
    const siblings = map.get(span.parentSpanId) ?? [];
    siblings.push(span);
    map.set(span.parentSpanId, siblings);
  }
  for (const siblings of map.values()) {
    siblings.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }
  return map;
}

export type TraceFilter = "all" | "model" | "tool" | "policy" | "warning" | "error";

/**
 * Filtering keeps every ancestor of a match, so a filtered tree is still a
 * tree: isolating one failing step never orphans it from the Run it belongs to.
 */
export function filterTraceSpans(spans: TraceSpan[], filter: TraceFilter): TraceSpan[] {
  if (filter === "all") return spans;
  const byId = new Map(spans.map((span) => [span.id, span]));
  const included = new Set<string>();
  for (const span of spans) {
    const matches =
      filter === "model"
        ? span.category.startsWith("model.")
        : filter === "tool"
          ? span.category === "tool.call"
          : filter === "policy"
            ? span.category === "policy.decision"
            : span.status === filter;
    if (!matches) continue;
    let current: TraceSpan | undefined = span;
    while (current) {
      if (included.has(current.id)) break;
      included.add(current.id);
      current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
    }
  }
  return spans.filter((span) => included.has(span.id));
}

/** The wall-clock window a trace occupies, in epoch milliseconds. */
export interface TraceWindow {
  start: number;
  end: number;
}

export function spanBounds(
  span: TraceSpan,
  now: number,
): { start: number; end: number } | null {
  const start = Date.parse(span.startedAt);
  if (!Number.isFinite(start)) return null;
  // An open span is still running, so it is drawn up to the present moment.
  const parsedEnd = span.completedAt ? Date.parse(span.completedAt) : now;
  return { start, end: Math.max(start, Number.isFinite(parsedEnd) ? parsedEnd : start) };
}

export function spanDurationMs(span: TraceSpan, now: number): number | null {
  if (span.durationMs !== null) return span.durationMs;
  if (span.status !== "running") return null;
  const bounds = spanBounds(span, now);
  return bounds ? bounds.end - bounds.start : null;
}

/** One axis for the whole trace, so every bar is comparable. */
export function traceWindow(spans: readonly TraceSpan[], now: number): TraceWindow | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    const bounds = spanBounds(span, now);
    if (!bounds) continue;
    start = Math.min(start, bounds.start);
    end = Math.max(end, bounds.end);
  }
  if (!Number.isFinite(start)) return null;
  // A zero-width window would divide by zero when the bars are laid out.
  return { start, end: Math.max(end, start + 1) };
}

/** Where a span's bar sits on the shared axis, as percentages. */
export function spanBarGeometry(
  span: TraceSpan,
  window: TraceWindow,
  now: number,
): { offset: number; width: number } | null {
  const bounds = spanBounds(span, now);
  if (!bounds) return null;
  const total = Math.max(1, window.end - window.start);
  const offset = Math.min(100, Math.max(0, ((bounds.start - window.start) / total) * 100));
  // An instantaneous span still needs to be findable on the axis.
  const width = Math.min(
    100 - offset,
    Math.max(1.2, ((bounds.end - bounds.start) / total) * 100),
  );
  return { offset, width };
}

export type CompareDirection = "better" | "worse" | "flat";

/**
 * Colour a delta only where the direction is unambiguous. More output tokens
 * is not worse, and pretending otherwise trains the reader to ignore the
 * colour on the metrics where it does mean something.
 */
export function compareDirection(
  delta: number | null,
  lowerIsBetter: boolean | undefined,
): CompareDirection {
  if (delta === null || delta === 0 || lowerIsBetter === undefined) return "flat";
  return (delta < 0) === lowerIsBetter ? "better" : "worse";
}

/** "1 warning", not "1 warnings". */
export function plural(count: number, noun: string): string {
  return count.toLocaleString() + " " + noun + (count === 1 ? "" : "s");
}
