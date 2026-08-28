# Glass Box: trace and audit middleware

The middleware capability this team designed on top of the Agent Launchpad
Starter Kit. Read it alongside
[ONE_PAGE_ARCHITECTURE.md](ONE_PAGE_ARCHITECTURE.md), which draws the same
design as a single page.

## The problem

The Starter Kit records the *result* of an Agent Run — a status, an output
string, an error string — and nothing about how the Run got there. Codex
reasons, executes commands, and edits files across many steps inside a
disposable container whose stdout is parsed for one final message and then
discarded. When a Run fails, the operator sees `Codex exited with code 1: boom`
and cannot answer the questions that matter:

- Which step failed, and what had the Agent already changed before it failed?
- How long did each step take, and what did the Run cost?
- Which Runtime, sandbox mode, and container engine actually executed it?
- Is there anything to hand to someone else as evidence?

This is Agent-specific. A Run is not one request; it is an autonomous,
multi-step process whose intermediate actions have real side effects on a
persistent workspace. Treating it as an opaque request/response is what makes
an Agent platform unoperable.

## The capability

Every Run emits a correlated, redacted **trace** — a tree of `TraceSpan`
records persisted beside Agents, messages, and Runs — plus a **versioned audit
bundle** that can leave the machine as evidence.

| Span | Category | Owns |
| --- | --- | --- |
| Root | `orchestration` | The whole Run: status, wall-clock duration, terminal error. |
| Process | `runtime.process` | One Runtime invocation: sandbox mode, runtime provider, container engine, token usage. |
| Event | `model.*`, `tool.call`, `runtime.warning`, `runtime.error`, `unknown.*` | One Codex item, with its redacted payload as attributes. |

### Stable identifiers

Every span stands alone: it carries the identity of what produced it, so a span
lifted out of the store is still interpretable.

| Field | Meaning |
| --- | --- |
| `traceId` | Correlates every span of one Run. Distinct from `runId` so an external tracer can join on it even if Runs are later retried or split. |
| `runId`, `id`, `parentSpanId` | Run, span, and tree position. |
| `agentId`, `agentVersion` | Which Agent, and which configuration version it executed against. `updateAgent` bumps the version only on a real change. |
| `sessionId` | The Codex thread this Run continued, correlating spans across Runs in one conversation. |
| `actorType` | `human` for the Run a person requested, `agent` for everything the Agent did beneath it, `system` for platform actions. |

The root span records `promptPreview` (redacted, first 200 characters) as well as
`promptLength`, and the process span records the model, its base URL, sandbox
mode, runtime provider, container engine, runtime image, and resource limits —
everything needed to diagnose a Run, and never the API key.

Two classification details do real work:

- **`item.started` and `item.completed` for the same item id are paired into one
  span**, so a step carries its actual duration instead of appearing twice as
  zero-width points. An item that starts and never completes becomes an explicit
  `warning` span rather than vanishing.
- **Known non-fatal Runtime diagnostics are downgraded to `warning`.** The Ark
  model-metadata fallback is noisy but harmless; classifying it as an error
  would train an operator to ignore red.

## Boundary and ownership

- **Who owns the decision.** `AgentService.executeRun` (the control plane) owns
  the trace. It persists the root span as `running` *before* the Runtime is
  invoked and closes every span in the same `store.mutate` transaction that
  transitions `AgentRun.status`. A Run can therefore never reach a terminal
  state without its trace being written, and a Run still executing is already
  observable through the API.
- **What crosses the boundary.** The `AgentRunner` interface stays thin: a
  runner returns `RunnerResult.events`, or throws a `RunnerExecutionError`
  carrying the events and partial usage it had observed. Because
  `RunCancelledError extends RunnerExecutionError`, a **cancelled** Run keeps
  its evidence too. Shaping raw events into spans lives entirely in `trace.ts`.
- **Trace ingestion never fails a Run.** Span construction is pure and
  synchronous. An unrecognized event type is stored as `unknown.<type>` rather
  than dropped or thrown.

## Span lifecycle and crash recovery

A span is written twice: open, then closed.

Cancellation is recorded as a relationship, not just a status: a closed span
carries `cancelledBy` — `operator` (someone pressed Stop), `agent-deleted`, or
`server-restart`.

| Phase | Root span | Process span | Event spans |
| --- | --- | --- | --- |
| Run accepted | `running`, `completedAt: null` | — | — |
| Runtime invoked | `running` | `running` | — |
| Terminal state | `ok` / `error` / `cancelled` | same | written from the observed events |
| Process killed mid-Run | `cancelled` on restart | `cancelled` on restart | whatever had been written |

Closing preserves span ids, so the terminal write **replaces** this Run's spans
rather than appending — appending would duplicate them.

On startup `initialize()` force-cancels orphaned Runs **and** closes every span
still marked `running`, stamping `"Server restarted while this run was active"`
with a computed duration. Without that, an interrupted Run would either carry no
trace at all or leave spans open forever — the single failure an observability
capability most needs to explain.

## Redaction and trust boundary

`redactSecrets` runs before anything is written to disk. It strips, in order:

1. every configured secret (the Ark API key) by exact match;
2. credential *shapes* the process was never told about — `Bearer` and `Basic`
   authorization headers, `sk-`, `ghp_`/`gho_`/`ghs_`/`github_pat_`, `xoxb-`,
   `AIza`, AWS `AKIA`/`ASIA` key ids, PEM private-key blocks including their
   body, and the value of any `*password`/`*secret`/`*api_key`/`*token`
   assignment (the name is kept, the value is not);
3. anything left over the length budget.

Step 2 matters because the Agent can *discover* a credential inside its own
workspace and echo it to stdout, where exact-match redaction against the Ark key
would never see it — and the audit bundle is built to be shared, so a miss there
is a disclosure rather than a local blemish.

Redaction is applied to every span attribute (recursively through nested objects
and arrays), every span error message, and `AgentRun.error` /
`Agent.lastError`, which surface in the UI and API.

The Ark key reaches the Runtime only as an environment variable
(`childEnvironment()` in both runners) and is never part of a Codex JSON event,
so string-match redaction is defence in depth rather than the only control.
`GET /api/runs/:id/trace` and `GET /api/runs/:id/audit` sit behind the same
bearer-auth hook as every other `/api/*` route, and the export path re-applies
redaction at serialization time because a bundle is meant to leave the machine.

## Retention

Traces are bounded on two axes so one Agent cannot exhaust the JSON store, which
rewrites the whole file on every mutation:

| Control | Default | Behaviour |
| --- | --- | --- |
| `TRACE_MAX_EVENT_SPANS_PER_RUN` | 500 | Keeps the most recent events for a Run — a failing step is normally at the tail — and records the dropped count in a `trace.truncated` warning span. |
| `TRACE_RETENTION_RUNS` | 200 | Keeps the newest N Runs, discarding older Runs **whole**, so a retained trace is never left with half its tree missing. |

Deleting an Agent deletes its spans along with its Runs and messages, matching
the existing workspace-archival policy.

## Seeded demo data

`npm run demo:seed` writes a fixture Agent with two complete traces into the
configured `APP_DATA_DIR`, so a reviewer can inspect the middleware without a
BytePlus ModelArk key. It refuses to overwrite a store that already holds Agents
unless `--force` is passed.

```bash
npm run demo:seed              # seed the default .data/ store
npm run demo:seed -- --force   # replace an existing store
```

The fixture is built to exercise every classification path: a successful Run
(reasoning, file writes, a passing command, a completed model turn) and a
failing Run (a started-but-never-completed turn, a file write, a failing
command, the benign model-metadata diagnostic downgraded to `warning`, and the
`runtime.error` that ended it). Every filter in the trace view is non-empty, the
stat cards are populated, and one span carries planted secrets already stored as
`[REDACTED]`.

## Demo script (three minutes)

The failure case below is deliberately an **Agent-caused failure**, not a
platform misconfiguration. Breaking `ARK_MODEL` would fail the Run before the
Agent does any work, producing a two-span trace that demonstrates nothing. The
point of this middleware is finding a failing step *among real work*, so the
demo has to produce real work first.

**Without Ark credentials?** Run `npm run demo:seed`, start the server, and
steps 3, 5, 6 and 8 all work against the fixture.

1. **Baseline.** `npm run poc`, open <http://localhost:3000>, create an Agent,
   and show its `ready` lifecycle state.
2. **Normal case.** Send `Create a TypeScript hello-world CLI, add a test, and
   run it.` A real model call, real file writes, and a real command execution
   inside the disposable container.
3. **Evidence.** Select **View trace**. Walk the tree: root → process →
   individual `tool.call` and `model.message` spans, each with its real
   duration. Read the stat cards — duration, tokens in/out/cached, tool calls
   and model turns, warnings and errors. Expand a `tool.call` to show the
   redacted payload. Use the count-badged filters to isolate `tool` or `model`
   spans; note the tree stays connected because filtering keeps ancestors.
4. **Failure case.** Send `Add a second test that asserts 1 === 2 so the suite
   fails, then run the whole suite and report the result.` The Agent reasons,
   edits a file, runs the suite, and the command exits non-zero — a Run that
   fails *after* doing real work.
5. **Locate the failing step.** Open the trace and filter to **error**. The
   failing step is isolated out of a dozen successful ones, carrying its
   redacted stderr, while the preceding `file_change` spans still show exactly
   what the Agent changed before it broke.
6. **Export the evidence.** Press **Export JSON** to download the audit bundle:
   `schemaVersion`, the redacted Run, the summary, and every span. Open it and
   point out that secrets are `[REDACTED]` in the file itself.
7. **Recovery case.** Start another task, and while it is running kill the
   server (`Ctrl+C`) and restart it. The Run is reconciled to `cancelled` and
   its spans are closed with `"Server restarted while this run was active"` —
   an interrupted Run still has a readable trace instead of nothing.
8. **Still controllable.** Open **Runs**, filter by `failed`, sort by duration
   or tokens, and confirm the Agent returns to `ready` and accepts a new task.

If short on time, cut step 7 — but it is the strongest recovery evidence in the
submission.

## Automated evidence

`npm run check` runs all of it.

| Behaviour | Test |
| --- | --- |
| Correlated trace for a successful Run | `agent-service.test.ts` — "records a correlated, successful trace for a completed run" |
| The failing step is identifiable | `agent-service.test.ts` — "identifies the failing step when a run fails" |
| A Run in flight already has a trace | `agent-service.test.ts` — "exposes an open trace before the Runtime returns" |
| A crash leaves no span stuck open | `agent-service.test.ts` — "closes spans left open by a crash when the server restarts" |
| Spans are deleted with their Agent | `agent-service.test.ts` — "removes an Agent's spans when the Agent is deleted" |
| Old Runs are pruned whole | `agent-service.test.ts` — "retains only the most recent Runs' spans"; `trace.test.ts` — `pruneSpans` |
| Per-Run event cap and its notice span | `trace.test.ts` — "event span capping" |
| started/completed pairing and durations | `trace.test.ts` — "pairs item lifecycle events and computes their duration" |
| An item that never completes is a warning | `trace.test.ts` — "marks an item with no completion event as a warning" |
| Benign diagnostics are not errors | `trace.test.ts` — "downgrades the known model metadata fallback event to a warning" |
| Redaction across nested payloads and batches | `trace.test.ts` — `redactSecrets`, `redactAttributes`, "never leaks a planted secret" |
| Unconfigured credential shapes are redacted | `trace.test.ts` — "credential pattern redaction" |
| Redaction does not disturb warning classification | `trace.test.ts` — "still lets the known model metadata fallback message through" |
| Export re-redacts and summarizes | `audit.test.ts` — "summarizes a run and redacts secrets again before export" |
| API routes require the shared token | `app.test.ts` — "protects API routes with the configured shared token" |
| One shared identity across a Run's spans | `agent-service.test.ts` — "stamps every span of a Run with one shared identity" |
| Model and infrastructure metadata recorded | `agent-service.test.ts` — "records the model and infrastructure needed to diagnose a Run" |
| Prompt preview is redacted | `agent-service.test.ts` — "keeps a redacted prompt preview on the root span" |
| Session id correlates Runs in a thread | `agent-service.test.ts` — "carries the Codex session id so Runs in one thread correlate" |
| Agent version bumps only on real change | `agent-service.test.ts` — "bumps the Agent version only on a real configuration change" |
| Cancellation records its cause | `agent-service.test.ts` — "records what cancelled a Run rather than only that it was cancelled" |

## Limitations

- **The Playground shows a trace only once a Run is terminal.** Both UI entry
  points gate on terminal status, so the `running` spans persisted at start are
  reachable through `GET /api/runs/:id/trace` but not yet through the browser.
  Wiring live updates needs an event callback through the runners plus polling
  in the panel; the span model already supports it.
- **Event spans are written at completion, not streamed.** The root and process
  spans are live; individual Codex events are collected by the runner and
  written when the turn ends.
- **No timeline visualisation.** Durations are shown as text per span. The data
  needed for a proportional timeline is present.
- **Redaction is pattern-matching.** It covers configured secrets plus the
  credential shapes listed above. A secret in a shape not on that list, or one
  that is base64- or hex-encoded before being printed, would still not be
  recognised. Pattern coverage is a moving target, not a guarantee.
- **No retry relationships, and no cost or resource-consumption signals.** The
  platform does not retry Runs, so there is nothing to link; token usage is
  recorded but not priced, and container CPU/memory are recorded as configured
  *limits* rather than measured consumption, which would need instrumentation
  inside the Runtime.
- **Span categories cover what this platform does.** `orchestration`,
  `model.*`, `tool.call`, `runtime.*`. There is no memory-access, policy-
  decision, human-approval, or cloud-operation category because no such
  capability exists here to instrument.
- **Payloads are stored verbatim.** Span attributes hold the whole raw Codex
  event, so a `file_change` item can carry substantial file content into the
  store and the export. There is no capture-level control to summarise them.
- **Event timestamps are observation times.** `observedAt` is when the control
  plane read the JSON line, not when Codex emitted it, so durations carry the
  control plane's scheduling jitter. Item types Codex reports only on completion
  have no `started` event to pair with and remain zero-width points.
- **Single-process JSON store.** Inherited from the Starter Kit. A real
  deployment would send spans to an OTLP collector; the span shape (id, parent,
  category, status, timings, attributes) maps onto OpenTelemetry deliberately,
  but no exporter is implemented.
- **No trace-level access control.** The POC is single-user; trace and audit
  access use the same shared bearer token as the rest of the API. Per-principal
  authorization belongs with an identity capability, which this team did not
  build.
- **The seeded fixture is static.** `npm run demo:seed` makes the middleware
  inspectable without credentials, but its Runs are fixtures: they exercise the
  trace, classification, summary, and export paths, not the Runtime.
