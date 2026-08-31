# AgentLens

Trace and audit middleware for the Agent Launchpad Starter Kit. See what an
Agent did, inspect where a Run stopped, and export machine-readable evidence.

**TikTok TechJam 2026 challenge:** Agent Launchpad - Design and Build Lightweight
Agent Middleware. Our focus is **Glass Box: trace, audit and observability**.

Built on [RrankPyramid/CodeJam](https://github.com/RrankPyramid/CodeJam). Agent
CRUD, the Playground, persistent workspaces, Codex integration and runtime
launchers are inherited infrastructure; our contribution is the connected
execution-evidence layer. Original licensing is retained.

> [!WARNING]
> Single-user proof of concept, not a hardened multi-tenant sandbox. Use empty
> demo workspaces and dedicated model credentials. See [SECURITY.md](SECURITY.md).

## Start here

| Goal | Entry point |
| --- | --- |
| Install, run, verify and stop | [English reviewer runbook](docs/RUNBOOK.md) |
| Windows + Docker Desktop instructions | [中文完整运行指南](docs/RUNBOOK.zh-CN.md) |
| Inspect without model credentials | [Fixture inspection](docs/RUNBOOK.md#5-credential-free-fixture-inspection) |
| Understand the one-page architecture | [Diagram and PDF/PNG/SVG downloads](docs/ONE_PAGE_ARCHITECTURE.md) |
| Read the submission description and team contributions | [English submission copy](docs/submission/DEVPOST.md) |
| Rehearse the demonstration | [Three-minute demo script](docs/submission/DEMO.md) |

## What the middleware adds

- **Live, correlated trace:** the root is stored before execution. Observed
  model/tool events are linked to the Run; started/completed events are paired.
  The browser polls these records while the Run is active.
- **Historical inspection:** filter and compare Runs, inspect a common timeline,
  reported token usage and elapsed time. Cost is estimated only when rates are
  configured; otherwise it is **Not priced**.
- **Audit export:** terminal Runs can be exported as versioned JSON with
  re-applied redaction. A separate verifier checks structure, timing and
  recognized credential indicators in the actual downloaded artifact.
- **Interruption evidence:** unfinished spans close at the Run boundary, and
  startup reconciles interrupted Runs. Older trace identities are backfilled
  with provenance instead of borrowing the Agent's current configuration.
- **Policy evidence:** observed allow/deny decisions become system spans.
  Denial requests runtime cancellation; this is not pre-execution approval.

Implementation, regression coverage and limitations are documented in
[GLASS_BOX.md](docs/GLASS_BOX.md). A failing tool command does **not** necessarily
make its parent Run fail; non-zero exit classification remains incomplete.

## Runtime profiles

| Profile | Requirements | Execution boundary |
| --- | --- | --- |
| Local POC | Linux/macOS, Git, Node 22+, npm 10+, Docker/Colima/Podman, Ark endpoint | Host API; disposable runtime container per turn |
| Windows Compose | Git, Docker Desktop with Linux containers, Ark endpoint | API and Codex processes share one application container |
| Fixture inspection | Git, Node 22+, npm 10+ | Stored synthetic Runs; no new model execution |

Codex CLI is supplied by the runtime/application image for container profiles.
Model execution requires a valid Ark key and a **Responses-compatible** model or
endpoint. A successful Chat Completions request is not sufficient evidence.

### Quick start: already configured

First-time users should follow the [runbook](docs/RUNBOOK.md), including its
credential and runtime-boundary instructions. Do not overwrite an existing
`.env` or assume it is loaded by every startup command.

For **Windows Compose**, start Docker Desktop, then from this checkout:

```powershell
docker compose config --quiet
docker compose up --build -d launchpad
docker compose ps
```

With the runbook's `PUBLIC_PORT=127.0.0.1:4242`, open
<http://127.0.0.1:4242/> and unlock using `APP_AUTH_TOKEN`, **not** the model key.
The unmodified template uses port 3000. To stop without deleting data:

```powershell
docker compose stop launchpad
```

For the **Linux/macOS local POC**, after privately exporting the model variables
as described in the runbook:

```bash
npm run poc
```

Open <http://127.0.0.1:3000/> with the runbook's default port; stop with Ctrl+C.
This Bash launcher does not load `.env`. Compose does load it. Neither closing
the browser nor closing a log-following terminal stops a detached Compose app.

## Screenshots

The completed trace and comparison below use labelled synthetic fixtures, not
proof of live model execution. Follow the [demo script](docs/submission/DEMO.md)
for the real frontend-to-Agent acceptance flow.

### Completed fixture trace

![Fixture Run with stat cards, filters and a trace timeline](docs/assets/trace-view.png)

### Live trace view

![Trace marked Live with running spans](docs/assets/trace-live.png)

### Run comparison

![Two fixture Runs compared side by side](docs/assets/run-compare.png)

The Starter Kit's original [Playground](docs/assets/playground.jpg) and
[Agent creation](docs/assets/create-agent.jpg) screenshots are retained as
baseline references, not claimed as new middleware.

## Configuration

See [.env.example](.env.example) for names and defaults; the runbook explains
which shell or Compose environment reads them. Keep all actual credentials and
local state out of Git.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARK_API_KEY`, `ARK_MODEL` | Unconfigured | Required for real model execution, not fixture inspection |
| `ARK_BASE_URL` | Beijing v3 endpoint | Must match the provider/key/region |
| `APP_AUTH_TOKEN` | Unconfigured in server; placeholder in template | Shared browser/API token; non-loopback production requires 24+ URL-safe characters |
| `RUNTIME_PROVIDER` | `local-process` | Compose keeps this; the POC launcher selects `container` |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Inner Codex sandbox; automatic probing/fallback exists only in the POC launcher |
| `CODEX_TIMEOUT_MS` | `600000` | Turn timeout |
| `POLICY_ENABLED`, `POLICY_RULES` | Enabled, built-in rules | Observational command denylist and cancellation requests |
| `TRACE_MAX_EVENT_SPANS_PER_RUN` | `500` | Bounded event history per Run |
| `TRACE_RETENTION_RUNS` | `200` | Retained traces, dropping older Runs' trace trees whole |
| `TRACE_COST_INPUT_PER_MTOK`, `TRACE_COST_CACHED_INPUT_PER_MTOK`, `TRACE_COST_OUTPUT_PER_MTOK` | `0` | Operator-supplied rates per million tokens; no configured rates means Not priced |
| `TRACE_COST_CURRENCY` | `USD` | Estimate label, not currency conversion |
| `LOCAL_POC_DATA_ROOT` | Platform-specific | POC metadata, workspaces and Codex state |

## Validation

With Node.js 22+ and npm 10+:

```bash
npm ci
npm run check
```

This runs typechecks, server/frontend tests and production builds without
calling a model. On Linux/macOS with Bash, curl and Node:

```bash
npm run verify:evidence
```

The latter starts a temporary fixture server, verifies exported audit bundles
and authentication, then stops it. Both checks run in
[CI](.github/workflows/check.yml); neither replaces a live model rehearsal.
To check a browser download, replace the path with the actual filename:

```bash
node scripts/verify-audit.mjs /path/to/downloaded-audit.json
```

## Known limits

Polling and a single-process JSON store suit a POC, not a high-volume service.
Token prices are estimates, tool-exit classification is incomplete, and command
policy observes then attempts cancellation rather than approving execution.
The Compose runtime shares application data and credentials; disposable
containers also are not a hardened tenant boundary. Redaction applies to
trace/audit payloads, not all conversation records or workspace files, and
unknown/encoded secrets can escape pattern matching.

See [security guidance](SECURITY.md) and the
[implementation limitations](docs/GLASS_BOX.md#limitations) before use.

## Further documentation

- [Component overview](docs/ARCHITECTURE.md) - ownership and source map.
- [Local container engine details](docs/LOCAL_POC.md) - Podman and mount troubleshooting.
- [Optional ECS deployment](docs/DEPLOYMENT.md) - not required for the local demo.
- [Contributing](CONTRIBUTING.md) - development setup and focused checks.
- [Team submission checklist](docs/submission/SUBMISSION_CHECKLIST.md) - internal preparation, not public submission text.
- [Archived Starter Kit challenge drafts](docs/archive/starter-kit/README.md) - historical context, not current submission rules.

## License

[MIT](LICENSE), retaining the Starter Kit's attribution.
