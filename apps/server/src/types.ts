export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

/** Who performed the work a span represents. */
export type ActorType = "human" | "agent" | "system";

export interface Agent {
  id: string;
  /** Bumped on every configuration change, so a trace pins the Agent it ran. */
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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export type SpanStatus = "running" | "ok" | "warning" | "error" | "cancelled";

export interface TraceSpan {
  id: string;
  /** Correlates every span of one Run; the unit an external tracer would join on. */
  traceId: string;
  runId: string;
  agentId: string;
  /** The Agent configuration version this Run executed against. */
  agentVersion: number;
  /** Codex thread this Run continued, correlating spans across Runs. */
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

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  spans: TraceSpan[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface PolicyRule {
  id: string;
  description: string;
  /** The asset the rule protects, so a denial explains what it defended. */
  asset: string;
  pattern: RegExp;
}

export interface PolicyDecision {
  decision: "allow" | "deny";
  ruleId: string | null;
  reason: string;
  protectedAsset: string | null;
  command: string;
}

export interface RawCodexEvent {
  observedAt: string;
  event: Record<string, unknown>;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  events?: RawCodexEvent[];
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /**
   * Invoked as each Codex JSON event is observed, so the control plane can
   * evaluate policy against an action while the turn is still running rather
   * than reporting on it afterwards.
   */
  onEvent?: ((event: RawCodexEvent) => void) | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
