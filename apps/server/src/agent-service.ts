import { randomUUID } from "node:crypto";
import { buildAuditBundle } from "./audit.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError, RunnerExecutionError } from "./errors.js";
import { JsonStore } from "./store.js";
import { evaluateEvent } from "./policy.js";
import {
  LiveTraceWriter,
  buildEventSpans,
  buildPolicySpan,
  buildProcessSpan,
  buildRunSpan,
  completeSpan,
  pruneSpans,
  redactSecrets,
} from "./trace.js";
import type { LiveSpanUpdate } from "./trace.js";
import type {
  Agent,
  PolicyDecision,
  AgentRun,
  AgentRunner,
  AuditBundle,
  CreateAgentInput,
  Message,
  SpanStatus,
  TraceSpan,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

/**
 * How much of the prompt the root span keeps. A length alone tells an operator
 * nothing about what was asked; the whole prompt is an unbounded payload the
 * trace should not carry.
 */
const PROMPT_PREVIEW_LENGTH = 200;

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Map<string, string>();
  private readonly policyDenials = new Map<string, PolicyDecision>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      const restartedAt = now();
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = restartedAt;
        }
      }
      // Spans the crashed process left open would otherwise stay "running"
      // forever, and an interrupted Run is exactly the case a trace exists to
      // explain, so close them instead of discarding the evidence.
      for (const span of database.spans) {
        if (span.status === "running") {
          span.status = "cancelled";
          span.completedAt = restartedAt;
          span.durationMs = Math.max(0, Date.parse(restartedAt) - Date.parse(span.startedAt));
          span.errorMessage = "Server restarted while this run was active";
          span.attributes = { ...span.attributes, cancelledBy: "server-restart" };
        }
      }
      for (const agent of database.agents) {
        // Stores written before Agents were versioned.
        if (typeof agent.version !== "number") agent.version = 1;
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      version: 1,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      const before = JSON.stringify([agent.name, agent.description, agent.instructions]);
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      // Only a real configuration change is a new version.
      if (JSON.stringify([agent.name, agent.description, agent.instructions]) !== before) {
        agent.version = (agent.version ?? 1) + 1;
      }
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id, "agent-deleted");
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.spans = database.spans.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getTrace(runId: string): TraceSpan[] {
    this.getRun(runId);
    return this.store
      .snapshot()
      .spans.filter((span) => span.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  getAuditBundle(runId: string): AuditBundle {
    const snapshot = this.store.snapshot();
    const run = snapshot.runs.find((item) => item.id === runId);
    if (!run) throw new HttpError(404, "Run not found");
    const agent = snapshot.agents.find((item) => item.id === run.agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    const spans = snapshot.spans.filter((span) => span.runId === runId);
    const secrets = this.config.arkApiKey ? [this.config.arkApiKey] : [];
    return buildAuditBundle(agent, run, spans, secrets, this.config.costRates);
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    const runStartedAt = now();
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = runStartedAt;
      }
    });
    const secrets = this.config.arkApiKey ? [this.config.arkApiKey] : [];
    // One identity shared by every span of this Run. traceId is distinct from
    // runId so an external tracer can join on it even if Runs are later
    // retried or split.
    const identity = {
      traceId: randomUUID(),
      runId: run.id,
      agentId: agentAtStart.id,
      agentVersion: agentAtStart.version ?? 1,
      sessionId: agentAtStart.codexThreadId,
    };
    const runSpan = buildRunSpan({
      ...identity,
      promptLength: run.prompt.length,
      promptPreview: redactSecrets(run.prompt.slice(0, PROMPT_PREVIEW_LENGTH), secrets),
      startedAt: runStartedAt,
    });
    await this.appendSpans([runSpan]);
    let processSpan: TraceSpan | null = null;
    const policySpans: TraceSpan[] = [];
    const liveWrites = this.createLiveSpanQueue();
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const containerRuntime = this.config.runtimeProvider === "container";
      processSpan = buildProcessSpan({
        ...identity,
        parentSpanId: runSpan.id,
        startedAt: now(),
        sandboxMode: this.config.codexSandboxMode,
        runtimeProvider: this.config.runtimeProvider,
        containerEngine: containerRuntime ? this.config.containerEngine : null,
        model: this.config.arkModel,
        modelBaseUrl: this.config.arkBaseUrl,
        runtimeImage: containerRuntime ? this.config.containerRuntimeImage : null,
        resourceLimits: containerRuntime
          ? {
              cpus: this.config.containerCpuLimit,
              memory: this.config.containerMemoryLimit,
              pids: this.config.containerPidsLimit,
            }
          : null,
      });
      await this.appendSpans([processSpan]);
      const policyParent = processSpan.id;
      // Spans are written as events arrive, so the trace is readable while the
      // Run is still executing. The authoritative set is still rewritten when
      // the Run ends; these are the same spans seen earlier.
      const liveWriter = new LiveTraceWriter(
        { ...identity, parentSpanId: policyParent },
        secrets,
        this.config.traceMaxEventSpansPerRun,
      );
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        onEvent: (event) => {
          liveWrites.record(liveWriter.ingest(event));
          if (!this.config.policyEnabled) return;
          const decision = evaluateEvent(event, this.config.policyRules);
          if (!decision) return;
          const policySpan = buildPolicySpan(
            decision,
            { ...identity, parentSpanId: policyParent },
            secrets,
            event.observedAt,
          );
          policySpans.push(policySpan);
          // A denial is the span the operator most needs to see immediately.
          liveWrites.record({ appended: [policySpan], updated: [] });
          if (decision.decision === "deny") {
            // Terminate at the Runtime boundary: removing the container
            // stops the Agent mid-turn rather than reporting afterwards.
            this.policyDenials.set(agentAtStart.id, decision);
            void this.runner.cancel(agentAtStart.id).catch(() => undefined);
          }
        },
      });
      const completedAt = now();
      // Any live write still in flight would otherwise land after the
      // rewrite below and resurrect a span it just replaced.
      await liveWrites.drain();
      const eventSpans = buildEventSpans(
        result.events ?? [],
        { ...identity, parentSpanId: processSpan.id },
        secrets,
        this.config.traceMaxEventSpansPerRun,
      );
      const completedProcessSpan = completeSpan(processSpan, "ok", completedAt, null, {
        usage: result.usage,
      });
      const completedRunSpan = completeSpan(runSpan, "ok", completedAt);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        // Replace the open spans written at start; completeSpan preserves ids,
        // so appending here would duplicate them.
        database.spans = database.spans.filter((span) => span.runId !== run.id);
        database.spans.push(
          completedRunSpan,
          completedProcessSpan,
          ...policySpans,
          ...eventSpans,
        );
        database.spans = pruneSpans(database.spans, this.config.traceRetentionRuns);
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      await liveWrites.drain();
      // A Run stopped by policy was terminated by the platform, not abandoned
      // by an operator, so it is a failure with a stated cause.
      const denial = this.policyDenials.get(agentAtStart.id) ?? null;
      this.policyDenials.delete(agentAtStart.id);
      const cancelled = denial === null && error instanceof RunCancelledError;
      const message = denial
        ? "Blocked by policy " + denial.ruleId + ": " + denial.reason
        : error instanceof Error
          ? error.message
          : String(error);
      const redactedMessage = redactSecrets(message, secrets);
      const status: SpanStatus = cancelled ? "cancelled" : "error";
      const cancellationReason = cancelled
        ? (this.cancellationRequests.get(agentAtStart.id) ?? "operator")
        : null;
      const closingAttributes = cancellationReason
        ? { cancelledBy: cancellationReason }
        : {};
      const runnerError = error instanceof RunnerExecutionError ? error : null;
      const eventSpans = processSpan && runnerError
        ? buildEventSpans(
            runnerError.events,
            { ...identity, parentSpanId: processSpan.id },
            secrets,
            this.config.traceMaxEventSpansPerRun,
          )
        : [];
      const spans: TraceSpan[] = [
        completeSpan(
          runSpan,
          status,
          completedAt,
          cancelled ? null : redactedMessage,
          closingAttributes,
        ),
      ];
      if (processSpan) {
        spans.push(
          completeSpan(
            processSpan,
            status,
            completedAt,
            cancelled ? null : redactedMessage,
            {
              ...closingAttributes,
              ...(runnerError?.usage ? { usage: runnerError.usage } : {}),
            },
          ),
          ...policySpans,
          ...eventSpans,
        );
      }
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = cancelled ? message : redactedMessage;
          storedRun.usage = runnerError?.usage ?? null;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : redactedMessage;
          agent.updatedAt = completedAt;
        }
        database.spans = database.spans.filter((span) => span.runId !== run.id);
        database.spans.push(...spans);
        database.spans = pruneSpans(database.spans, this.config.traceRetentionRuns);
      });
    }
  }

  /**
   * Serialises the writes an in-flight Run makes to the store. `onEvent` is
   * synchronous and persisting is not, so updates are chained rather than
   * raced, and `drain` gives the Run a point where every one has landed.
   */
  private createLiveSpanQueue(): {
    record: (update: LiveSpanUpdate) => void;
    drain: () => Promise<void>;
  } {
    let queue: Promise<void> = Promise.resolve();
    return {
      record: (update) => {
        if (update.appended.length === 0 && update.updated.length === 0) return;
        queue = queue
          .then(() =>
            this.store.mutate((database) => {
              for (const span of update.updated) {
                const index = database.spans.findIndex((item) => item.id === span.id);
                if (index >= 0) database.spans[index] = span;
                else database.spans.push(span);
              }
              database.spans.push(...update.appended);
            }),
          )
          // A trace that cannot be written must not fail the Run it describes.
          .catch(() => undefined);
      },
      drain: () => queue,
    };
  }

  private async appendSpans(spans: readonly TraceSpan[]): Promise<void> {
    if (spans.length === 0) return;
    await this.store.mutate((database) => {
      database.spans.push(...spans);
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string, reason = "operator"): Promise<void> {
    this.cancellationRequests.set(agentId, reason);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
