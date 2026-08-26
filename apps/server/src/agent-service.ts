import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError, runnerEventsFrom } from "./errors.js";
import { JsonStore } from "./store.js";
import {
  buildEventSpans,
  buildProcessSpan,
  buildRunSpan,
  completeSpan,
  pruneSpans,
  redactSecrets,
} from "./trace.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RawCodexEvent,
  SpanStatus,
  TraceSpan,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

/**
 * How long streamed event spans may sit in memory before being written. One
 * store write per Codex event would rewrite the whole JSON file hundreds of
 * times per Run, so events are batched; the trace is still live enough to
 * watch a Run progress.
 */
const TRACE_FLUSH_INTERVAL_MS = 750;

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

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
      // Spans left open by the crashed process would otherwise stay "running"
      // forever, so the trace for an interrupted Run stays readable.
      for (const span of database.spans) {
        if (span.status === "running") {
          span.status = "cancelled";
          span.completedAt = restartedAt;
          span.durationMs = Math.max(0, Date.parse(restartedAt) - Date.parse(span.startedAt));
          span.errorMessage = "Server restarted while this run was active";
        }
      }
      for (const agent of database.agents) {
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
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
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
    const runSpan = buildRunSpan({
      runId: run.id,
      agentId: agentAtStart.id,
      promptLength: run.prompt.length,
      startedAt: runStartedAt,
    });
    await this.appendSpans([runSpan]);
    const streamed = this.createEventStream(run.id, agentAtStart.id, secrets);
    let processSpan: TraceSpan | null = null;
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      processSpan = buildProcessSpan({
        runId: run.id,
        agentId: agentAtStart.id,
        parentSpanId: runSpan.id,
        startedAt: now(),
        sandboxMode: this.config.codexSandboxMode,
        runtimeProvider: this.config.runtimeProvider,
        containerEngine:
          this.config.runtimeProvider === "container" ? this.config.containerEngine : null,
      });
      await this.appendSpans([processSpan]);
      streamed.attachTo(processSpan.id);
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        onEvent: streamed.onEvent,
      });
      await streamed.stop();
      const completedAt = now();
      const observed = streamed.observed();
      const eventSpans = buildEventSpans(
        observed.length > 0 ? observed : (result.events ?? []),
        { runId: run.id, agentId: agentAtStart.id, parentSpanId: processSpan.id },
        secrets,
        this.config.traceMaxEventSpansPerRun,
        this.config.traceCaptureLevel,
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
        database.spans = database.spans.filter((span) => span.runId !== run.id);
        database.spans.push(completedRunSpan, completedProcessSpan, ...eventSpans);
        database.spans = pruneSpans(database.spans, this.config.traceRetentionRuns);
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      await streamed.stop();
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      const redactedMessage = redactSecrets(message, secrets);
      const status: SpanStatus = cancelled ? "cancelled" : "error";
      const spans: TraceSpan[] = [
        completeSpan(runSpan, status, completedAt, cancelled ? null : redactedMessage),
      ];
      if (processSpan) {
        spans.push(
          completeSpan(processSpan, status, completedAt, cancelled ? null : redactedMessage),
          ...buildEventSpans(
            streamed.observed().length > 0 ? streamed.observed() : runnerEventsFrom(error),
            { runId: run.id, agentId: agentAtStart.id, parentSpanId: processSpan.id },
            secrets,
            this.config.traceMaxEventSpansPerRun,
            this.config.traceCaptureLevel,
          ),
        );
      }
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = redactedMessage;
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

  private async appendSpans(spans: readonly TraceSpan[]): Promise<void> {
    if (spans.length === 0) return;
    await this.store.mutate((database) => {
      database.spans.push(...spans);
    });
  }

  /**
   * Buffers Codex events and flushes them to the store as provisional spans
   * while the Run is still executing, so a trace can be watched live. The
   * spans written here are replaced by the authoritative, capped set when the
   * Run reaches a terminal state.
   */
  private createEventStream(
    runId: string,
    agentId: string,
    secrets: readonly string[],
  ): {
    onEvent: (event: RawCodexEvent) => void;
    attachTo: (parentSpanId: string) => void;
    observed: () => readonly RawCodexEvent[];
    stop: () => Promise<void>;
  } {
    const pending: RawCodexEvent[] = [];
    const seen: RawCodexEvent[] = [];
    let parentSpanId: string | null = null;
    let streamedCount = 0;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let inFlight: Promise<void> = Promise.resolve();

    const flush = () => {
      timer = null;
      if (parentSpanId === null || pending.length === 0) return;
      const budget = this.config.traceMaxEventSpansPerRun - streamedCount;
      const batch = pending.splice(0, pending.length).slice(0, Math.max(0, budget));
      if (batch.length === 0) return;
      streamedCount += batch.length;
      const spans = buildEventSpans(
        batch,
        { runId, agentId, parentSpanId },
        secrets,
        Number.POSITIVE_INFINITY,
        this.config.traceCaptureLevel,
      );
      inFlight = inFlight
        .then(() => this.appendSpans(spans))
        .catch(() => undefined);
    };

    const schedule = () => {
      if (stopped || timer !== null) return;
      timer = setTimeout(flush, TRACE_FLUSH_INTERVAL_MS);
      timer.unref();
    };

    return {
      onEvent: (event) => {
        if (stopped) return;
        seen.push(event);
        pending.push(event);
        schedule();
      },
      observed: () => seen,
      attachTo: (spanId) => {
        parentSpanId = spanId;
        if (pending.length > 0) schedule();
      },
      stop: async () => {
        stopped = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        await inFlight;
      },
    };
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

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
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
