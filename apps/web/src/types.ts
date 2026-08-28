export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export type SpanStatus = "running" | "ok" | "warning" | "error" | "cancelled";

export type ActorType = "human" | "agent" | "system";

export interface TraceSpan {
  id: string;
  traceId: string;
  runId: string;
  agentId: string;
  agentVersion: number;
  sessionId: string | null;
  actorType: ActorType;
  parentSpanId: string | null;
  category: string;
  name: string;
  status: SpanStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  attributes: Record<string, unknown>;
  errorMessage: string | null;
}

export interface AuditSummary {
  durationMs: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelTurns: number;
  toolCalls: number;
  policyDecisions: number;
  policyDenials: number;
  warnings: number;
  errors: number;
  spanCount: number;
}

export interface AuditBundle {
  schemaVersion: 1;
  exportedAt: string;
  agent: Pick<Agent, "id" | "name">;
  run: AgentRun;
  summary: AuditSummary;
  spans: TraceSpan[];
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
