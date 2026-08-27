import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type {
  Agent,
  AgentRun,
  AuditBundle,
  Message,
  SystemInfo,
  TraceSpan,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function runDurationMs(run: AgentRun): number | null {
  if (!run.startedAt || !run.completedAt) return null;
  const durationMs = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs < 1_000) return durationMs + " ms";
  return (durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0) + " s";
}

function formatRunDuration(run: AgentRun): string {
  if (!run.startedAt) return run.status === "queued" ? "Queued" : "—";
  if (!run.completedAt) return "Running";
  return formatDuration(runDurationMs(run));
}

function runTokens(run: AgentRun): number {
  return (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);
}

function formatRunUsage(run: AgentRun): string {
  const total = runTokens(run);
  return total ? total.toLocaleString() + " tokens" : "No usage";
}

function StatCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function buildSpanChildren(spans: TraceSpan[]): Map<string | null, TraceSpan[]> {
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

type TraceFilter = "all" | "model" | "tool" | "warning" | "error";

function filterTraceSpans(spans: TraceSpan[], filter: TraceFilter): TraceSpan[] {
  if (filter === "all") return spans;
  const byId = new Map(spans.map((span) => [span.id, span]));
  const included = new Set<string>();
  for (const span of spans) {
    const matches =
      filter === "model"
        ? span.category.startsWith("model.")
        : filter === "tool"
          ? span.category === "tool.call"
          : span.status === filter;
    if (!matches) continue;
    let current: TraceSpan | undefined = span;
    while (current) {
      included.add(current.id);
      current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
    }
  }
  return spans.filter((span) => included.has(span.id));
}

function SpanNode({
  span,
  childrenBySpanId,
  depth,
}: {
  span: TraceSpan;
  childrenBySpanId: Map<string | null, TraceSpan[]>;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const children = childrenBySpanId.get(span.id) ?? [];
  return (
    <div className="span-node" style={{ marginLeft: depth * 18 }}>
      <button type="button" className="span-row" onClick={() => setExpanded((value) => !value)}>
        <span className={"span-status span-status-" + span.status}>
          <span className="status-dot" />
          {span.status}
        </span>
        <span className="span-name">{span.name}</span>
        <span className="span-category">{span.category}</span>
        <span className="span-duration">
          {span.durationMs !== null ? span.durationMs + " ms" : "—"}
        </span>
      </button>
      {span.errorMessage && (
        <div className={"span-error span-error-" + span.status}>{span.errorMessage}</div>
      )}
      {expanded && (
        <pre className="span-attributes">{JSON.stringify(span.attributes, null, 2)}</pre>
      )}
      {children.map((child) => (
        <SpanNode
          key={child.id}
          span={child}
          childrenBySpanId={childrenBySpanId}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function TracePanel({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [bundle, setBundle] = useState<AuditBundle | null>(null);
  const [filter, setFilter] = useState<TraceFilter>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setBundle(null);
    setFilter("all");
    setError(null);
    api
      .audit(runId)
      .then((result) => {
        if (active) setBundle(result);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [runId]);

  const visibleSpans = useMemo(
    () => filterTraceSpans(bundle?.spans ?? [], filter),
    [bundle, filter],
  );
  const childrenBySpanId = useMemo(() => buildSpanChildren(visibleSpans), [visibleSpans]);
  const roots = childrenBySpanId.get(null) ?? [];

  const downloadAudit = () => {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2) + "\n"], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `agentlens-run-${bundle.run.id}-audit.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const filterCounts: Record<TraceFilter, number> = {
    all: bundle?.summary.spanCount ?? 0,
    model: bundle?.spans.filter((span) => span.category.startsWith("model.")).length ?? 0,
    tool: bundle?.summary.toolCalls ?? 0,
    warning: bundle?.summary.warnings ?? 0,
    error: bundle?.summary.errors ?? 0,
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-trace" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Glass Box audit</span>
            <h2>Run trace</h2>
            <p>Inspect every step, then export a redacted evidence bundle.</p>
          </div>
          <div className="modal-heading-actions">
            <button
              type="button"
              className="button button-ghost export-button"
              disabled={!bundle}
              onClick={downloadAudit}
            >
              ↓ Export JSON
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {!error && !bundle && (
          <div className="trace-loading">
            <Spinner />
          </div>
        )}
        {bundle && (
          <>
            <div className="insight-grid trace-insights">
              <StatCard label="Duration" value={formatDuration(bundle.summary.durationMs)} />
              <StatCard
                label="Tokens"
                value={bundle.summary.totalTokens.toLocaleString()}
                detail={`${bundle.summary.inputTokens.toLocaleString()} in · ${bundle.summary.outputTokens.toLocaleString()} out${bundle.summary.cachedInputTokens ? ` · ${bundle.summary.cachedInputTokens.toLocaleString()} cached` : ""}`}
              />
              <StatCard
                label="Tool calls"
                value={bundle.summary.toolCalls.toLocaleString()}
                detail={`${bundle.summary.modelTurns.toLocaleString()} model turns`}
              />
              <StatCard
                label="Signals"
                value={(bundle.summary.warnings + bundle.summary.errors).toLocaleString()}
                detail={`${bundle.summary.warnings} warnings · ${bundle.summary.errors} errors`}
              />
            </div>
            <div className="filter-bar trace-filter-bar" aria-label="Trace filters">
              {([
                ["all", "All"],
                ["model", "Model"],
                ["tool", "Tools"],
                ["warning", "Warnings"],
                ["error", "Errors"],
              ] as Array<[TraceFilter, string]>).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={filter === value ? "filter-chip active" : "filter-chip"}
                  onClick={() => setFilter(value)}
                >
                  {label}<span>{filterCounts[value]}</span>
                </button>
              ))}
            </div>
            {roots.length === 0 ? (
              <p className="trace-empty">No spans match this filter.</p>
            ) : (
              <div className="trace-tree">
                {roots.map((root) => (
                  <SpanNode
                    key={root.id}
                    span={root}
                    childrenBySpanId={childrenBySpanId}
                    depth={0}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RunHistoryPanel({
  runs,
  onTrace,
  onClose,
}: {
  runs: AgentRun[];
  onTrace: (runId: string) => void;
  onClose: () => void;
}) {
  const [statusFilter, setStatusFilter] = useState<"all" | AgentRun["status"]>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"newest" | "duration" | "tokens">("newest");

  const filteredRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return runs
      .filter((run) => statusFilter === "all" || run.status === statusFilter)
      .filter((run) => {
        if (!normalizedQuery) return true;
        return [run.prompt, run.output, run.error]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .sort((left, right) => {
        if (sort === "duration") {
          return (runDurationMs(right) ?? -1) - (runDurationMs(left) ?? -1);
        }
        if (sort === "tokens") return runTokens(right) - runTokens(left);
        return right.createdAt.localeCompare(left.createdAt);
      });
  }, [query, runs, sort, statusFilter]);

  const terminalRuns = filteredRuns.filter((run) =>
    ["completed", "failed", "cancelled"].includes(run.status),
  );
  const durations = filteredRuns
    .map(runDurationMs)
    .filter((value): value is number => value !== null);
  const successRate = terminalRuns.length
    ? Math.round(
        (terminalRuns.filter((run) => run.status === "completed").length /
          terminalRuns.length) * 100,
      ) + "%"
    : "—";
  const averageDuration = durations.length
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : null;
  const totalTokens = filteredRuns.reduce((sum, run) => sum + runTokens(run), 0);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-runs" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading run-history-heading">
          <div>
            <span className="eyebrow">Agent diagnostics</span>
            <h2>Run history</h2>
            <p>Compare outcomes, usage, and latency across this Agent's runs.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {runs.length === 0 ? (
          <p className="trace-empty">This Agent has not run yet.</p>
        ) : (
          <>
            <div className="run-controls">
              <input
                type="search"
                aria-label="Search runs"
                placeholder="Search prompts and errors…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <label className="compact-field">
                <span>Status</span>
                <select
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as "all" | AgentRun["status"])
                  }
                >
                  <option value="all">All statuses</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
              <label className="compact-field">
                <span>Sort</span>
                <select
                  value={sort}
                  onChange={(event) =>
                    setSort(event.target.value as "newest" | "duration" | "tokens")
                  }
                >
                  <option value="newest">Newest first</option>
                  <option value="duration">Longest duration</option>
                  <option value="tokens">Most tokens</option>
                </select>
              </label>
            </div>
            <div className="insight-grid run-insights">
              <StatCard label="Runs" value={filteredRuns.length.toLocaleString()} detail="matching filters" />
              <StatCard label="Success" value={successRate} detail="terminal runs" />
              <StatCard label="Avg. duration" value={formatDuration(averageDuration)} />
              <StatCard label="Total tokens" value={totalTokens.toLocaleString()} />
            </div>
            <div className="result-caption">
              Showing {filteredRuns.length} of {runs.length} runs
            </div>
            {filteredRuns.length === 0 ? (
              <div className="filtered-empty">
                <strong>No matching runs</strong>
                <span>Try a different status or search term.</span>
              </div>
            ) : (
              <div className="run-history-list">
                {filteredRuns.map((run) => {
                  const terminal = ["completed", "failed", "cancelled"].includes(run.status);
                  return (
                    <article className="run-history-row" key={run.id}>
                      <div className="run-history-main">
                        <div className="run-history-meta">
                          <span className={"run-status run-status-" + run.status}>{run.status}</span>
                          <span>{formatTime(run.createdAt)}</span>
                          <span>{formatRunDuration(run)}</span>
                          <span>{formatRunUsage(run)}</span>
                        </div>
                        <p>{run.prompt}</p>
                        {run.error && <span className="run-history-error">{run.error}</span>}
                      </div>
                      <button
                        type="button"
                        className="button button-ghost"
                        disabled={!terminal}
                        onClick={() => onTrace(run.id)}
                      >
                        View trace
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [traceRunId, setTraceRunId] = useState<string | null>(null);
  const [showRunHistory, setShowRunHistory] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshRuns = useCallback(async (agentId: string) => {
    const result = await api.runs(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setRuns(result.runs);
    }
    return result.runs;
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setRuns([]);
    setShowSettings(false);
    setShowRunHistory(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), refreshRuns(selectedId)])
      .then(([, nextRuns]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = nextRuns[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, refreshRuns, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) {
          setActiveRun(result.run);
          setRuns((current) =>
            current.map((run) => run.id === result.run.id ? result.run : run),
          );
        }
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshRuns(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setRuns((current) => [
          result.run,
          ...current.filter((run) => run.id !== result.run.id),
        ]);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="playground-actions">
                  <button
                    type="button"
                    className="button button-ghost run-history-button"
                    onClick={() => setShowRunHistory(true)}
                    disabled={runs.length === 0}
                  >
                    Runs <span>{runs.length}</span>
                  </button>
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                {activeRun && ["completed", "failed", "cancelled"].includes(activeRun.status) && (
                  <div className="trace-entry">
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setTraceRunId(activeRun.id)}
                    >
                      View trace
                    </button>
                  </div>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}

      {traceRunId && (
        <TracePanel runId={traceRunId} onClose={() => setTraceRunId(null)} />
      )}
      {showRunHistory && (
        <RunHistoryPanel
          runs={runs}
          onClose={() => setShowRunHistory(false)}
          onTrace={(runId) => {
            setShowRunHistory(false);
            setTraceRunId(runId);
          }}
        />
      )}
    </div>
  );
}
