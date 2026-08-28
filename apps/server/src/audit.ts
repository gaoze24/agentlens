import { redactAttributes, redactSecrets } from "./trace.js";
import type { Agent, AgentRun, AuditBundle, AuditSummary, TraceSpan } from "./types.js";

function durationForRun(run: AgentRun): number | null {
  if (!run.startedAt || !run.completedAt) return null;
  const startedAt = Date.parse(run.startedAt);
  const completedAt = Date.parse(run.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null;
  return Math.max(0, completedAt - startedAt);
}

export function summarizeAudit(run: AgentRun, spans: readonly TraceSpan[]): AuditSummary {
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
  };
}

export function buildAuditBundle(
  agent: Agent,
  run: AgentRun,
  spans: readonly TraceSpan[],
  secrets: readonly string[],
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
    schemaVersion: 1,
    exportedAt,
    agent: { id: agent.id, name: agent.name },
    run: sanitizedRun,
    summary: summarizeAudit(sanitizedRun, sanitizedSpans),
    spans: sanitizedSpans,
  };
}
