import { redactAttributes, redactSecrets } from "./trace.js";
import type {
  Agent,
  AgentRun,
  AuditBundle,
  AuditCost,
  AuditCostRates,
  AuditSummary,
  TraceSpan,
} from "./types.js";

const UNPRICED: AuditCostRates = {
  currency: "USD",
  inputPerMillion: 0,
  cachedInputPerMillion: 0,
  outputPerMillion: 0,
};

/**
 * Codex reports cached input tokens as a subset of the input tokens, so
 * pricing both at the full rate would double-charge the cached half.
 */
function estimateCost(
  usage: AgentRun["usage"],
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  rates: AuditCostRates,
): AuditCost | null {
  // A Run that has not reported usage yet -- one still executing, or one whose
  // Runtime never reported any -- is unpriced, not free.
  if (usage === null) return null;
  const priced =
    rates.inputPerMillion > 0 ||
    rates.cachedInputPerMillion > 0 ||
    rates.outputPerMillion > 0;
  if (!priced) return null;
  const billedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const total =
    (billedInputTokens * rates.inputPerMillion +
      cachedInputTokens * rates.cachedInputPerMillion +
      outputTokens * rates.outputPerMillion) /
    1_000_000;
  return {
    ...rates,
    billedInputTokens,
    cachedInputTokens,
    outputTokens,
    // Six places keeps a sub-cent Run from rounding away to nothing.
    estimatedTotal: Math.round(total * 1_000_000) / 1_000_000,
  };
}

function durationForRun(run: AgentRun): number | null {
  if (!run.startedAt || !run.completedAt) return null;
  const startedAt = Date.parse(run.startedAt);
  const completedAt = Date.parse(run.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null;
  return Math.max(0, completedAt - startedAt);
}

export function summarizeAudit(
  run: AgentRun,
  spans: readonly TraceSpan[],
  rates: AuditCostRates = UNPRICED,
): AuditSummary {
  const inputTokens = run.usage?.inputTokens ?? 0;
  const cachedInputTokens = run.usage?.cachedInputTokens ?? 0;
  const outputTokens = run.usage?.outputTokens ?? 0;
  const completedTurns = spans.filter(
    (span) => span.category === "model.turn" && span.attributes.type === "turn.completed",
  ).length;
  const startedTurns = spans.filter(
    (span) => span.category === "model.turn" && span.attributes.type === "turn.started",
  ).length;
  return {
    durationMs: durationForRun(run),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    modelTurns: completedTurns || startedTurns,
    toolCalls: spans.filter((span) => span.category === "tool.call").length,
    policyDecisions: spans.filter((span) => span.category === "policy.decision").length,
    policyDenials: spans.filter(
      (span) => span.category === "policy.decision" && span.attributes.decision === "deny",
    ).length,
    warnings: spans.filter((span) => span.status === "warning").length,
    errors: spans.filter((span) => span.status === "error").length,
    spanCount: spans.length,
    cost: estimateCost(run.usage, inputTokens, cachedInputTokens, outputTokens, rates),
  };
}

export function buildAuditBundle(
  agent: Agent,
  run: AgentRun,
  spans: readonly TraceSpan[],
  secrets: readonly string[],
  rates: AuditCostRates = UNPRICED,
  exportedAt = new Date().toISOString(),
): AuditBundle {
  const sanitizedRun: AgentRun = {
    ...run,
    prompt: redactSecrets(run.prompt, secrets),
    output: run.output === null ? null : redactSecrets(run.output, secrets),
    error: run.error === null ? null : redactSecrets(run.error, secrets),
  };
  const sanitizedSpans = spans
    .map((span) => ({
      ...span,
      attributes: redactAttributes(span.attributes, secrets),
      errorMessage:
        span.errorMessage === null ? null : redactSecrets(span.errorMessage, secrets),
    }))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return {
    schemaVersion: 2,
    exportedAt,
    agent: { id: agent.id, name: agent.name },
    run: sanitizedRun,
    summary: summarizeAudit(sanitizedRun, sanitizedSpans, rates),
    spans: sanitizedSpans,
  };
}
