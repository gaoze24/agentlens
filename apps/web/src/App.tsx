import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRun, Message, SystemInfo, TraceSpan } from "./types";

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
      {span.errorMessage && <div className="span-error">{span.errorMessage}</div>}
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

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return ms + " ms";
  return (ms / 1_000).toFixed(1) + " s";
}

function totalTokens(usage: AgentRun["usage"]): number | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return input + output > 0 ? input + output : null;
}

function TracePanel({
  runId,
  run,
  onClose,
}: {
  runId: string;
  run: AgentRun | null;
  onClose: () => void;
}) {
  const [spans, setSpans] = useState<TraceSpan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);

  const live = run !== null && ["queued", "running"].includes(run.status);

  useEffect(() => {
    let active = true;
    setSpans(null);
    setError(null);
    setErrorsOnly(false);
    const load = () =>
      api
        .trace(runId)
        .then((result) => {
          if (active) setSpans(result.spans);
        })
        .catch((reason) => {
          if (active) setError(reason instanceof Error ? reason.message : String(reason));
        });
    void load();
    return () => {
      active = false;
    };
  }, [runId]);

  // While the Run is still executing, keep pulling the growing trace.
  useEffect(() => {
    if (!live) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api
        .trace(runId)
        .then((result) => {
          if (active) setSpans(result.spans);
        })
        .catch(() => undefined);
    }, 1_200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, runId]);

  const childrenBySpanId = useMemo(() => buildSpanChildren(spans ?? []), [spans]);
  const roots = childrenBySpanId.get(null) ?? [];
  const failingSpans = useMemo(
    () => (spans ?? []).filter((span) => span.status === "error"),
    [spans],
  );
  const rootSpan = roots[0] ?? null;
  const tokens = totalTokens(run?.usage ?? null);

  const exportTrace = () => {
    if (!spans) return;
    const blob = new Blob([JSON.stringify({ runId, spans }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "trace-" + runId + ".json";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-trace" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Run diagnostics</span>
            <h2>Trace</h2>
              <p>
              {live
                ? "Streaming: spans appear as the Run executes."
                : "Correlated Run and step events. Secrets are redacted before storage."}
            </p>
          </div>
          <button type="button" onClick={onClose}>×</button>
        </div>

        {spans && (
          <div className="trace-summary">
            <div>
              <span className="trace-summary-label">Status</span>
              <span className={"span-status span-status-" + (rootSpan?.status ?? "ok")}>
                <span className="status-dot" />
                {run?.status ?? rootSpan?.status ?? "unknown"}
              </span>
            </div>
            <div>
              <span className="trace-summary-label">Duration</span>
              <strong>
                {live ? "running…" : formatDuration(rootSpan?.durationMs ?? null)}
              </strong>
            </div>
            <div>
              <span className="trace-summary-label">Spans</span>
              <strong>{spans.length}</strong>
            </div>
            <div>
              <span className="trace-summary-label">Tokens</span>
              <strong>{tokens === null ? "—" : tokens}</strong>
            </div>
            <div className="trace-summary-actions">
              <button
                type="button"
                className="button button-ghost"
                disabled={failingSpans.length === 0}
                onClick={() => setErrorsOnly((value) => !value)}
              >
                {errorsOnly
                  ? "Show all spans"
                  : "Failing steps (" + failingSpans.length + ")"}
              </button>
              <button type="button" className="button button-ghost" onClick={exportTrace}>
                Export JSON
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {!error && !spans && (
          <div className="trace-loading">
            <Spinner />
          </div>
        )}
        {spans && roots.length === 0 && (
          <p className="trace-empty">No spans recorded for this run.</p>
        )}
        {spans && roots.length > 0 && errorsOnly && (
          <div className="trace-tree">
            {failingSpans.map((span) => (
              <SpanNode
                key={span.id}
                span={span}
                childrenBySpanId={new Map()}
                depth={0}
              />
            ))}
          </div>
        )}
        {spans && roots.length > 0 && !errorsOnly && (
          <div className="trace-tree">
            {roots.map((root) => (
              <SpanNode key={root.id} span={root} childrenBySpanId={childrenBySpanId} depth={0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const runFilters = ["all", "completed", "failed", "cancelled"] as const;
type RunFilter = (typeof runFilters)[number];

function RunsPanel({
  runs,
  onClose,
  onSelectRun,
}: {
  runs: AgentRun[];
  onClose: () => void;
  onSelectRun: (run: AgentRun) => void;
}) {
  const [filter, setFilter] = useState<RunFilter>("all");
  const visible = runs.filter((run) => filter === "all" || run.status === filter);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-trace" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Run history</span>
            <h2>Runs</h2>
            <p>Every Run this Agent has executed. Open one to inspect its trace.</p>
          </div>
          <button type="button" onClick={onClose}>×</button>
        </div>
        <div className="run-filters">
          {runFilters.map((option) => (
            <button
              key={option}
              type="button"
              className={"run-filter" + (filter === option ? " run-filter-active" : "")}
              onClick={() => setFilter(option)}
            >
              {option}
            </button>
          ))}
        </div>
        {visible.length === 0 ? (
          <p className="trace-empty">No Runs match this filter.</p>
        ) : (
          <div className="trace-tree">
            {visible.map((run) => (
              <button
                key={run.id}
                type="button"
                className="run-row"
                onClick={() => onSelectRun(run)}
              >
                <span className={"span-status span-status-" + statusToSpanStatus(run.status)}>
                  <span className="status-dot" />
                  {run.status}
                </span>
                <span className="run-row-prompt">{run.prompt}</span>
                <span className="span-duration">{formatTime(run.createdAt)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function statusToSpanStatus(status: AgentRun["status"]): string {
  if (status === "failed") return "error";
  if (status === "cancelled") return "cancelled";
  if (status === "queued" || status === "running") return "running";
  return "ok";
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
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
  const [traceRun, setTraceRun] = useState<AgentRun | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [showRuns, setShowRuns] = useState(false);
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
    setShowRuns(false);
    setTraceRun(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), refreshRuns(selectedId)])
      .then(([, agentRuns]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = agentRuns[0] ?? null;
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
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents(), refreshRuns(agentId)]);
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
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
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
                <div className="trace-entry">
                  {activeRun && (
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setTraceRun(activeRun)}
                    >
                      {["queued", "running"].includes(activeRun.status)
                        ? "View live trace"
                        : "View trace"}
                    </button>
                  )}
                  {runs.length > 0 && (
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setShowRuns(true)}
                    >
                      Run history ({runs.length})
                    </button>
                  )}
                </div>
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

      {showRuns && (
        <RunsPanel
          runs={runs}
          onClose={() => setShowRuns(false)}
          onSelectRun={(run) => {
            setShowRuns(false);
            setTraceRun(run);
          }}
        />
      )}

      {traceRun && (
        <TracePanel
          runId={traceRun.id}
          run={activeRun?.id === traceRun.id ? activeRun : traceRun}
          onClose={() => setTraceRun(null)}
        />
      )}
    </div>
  );
}
