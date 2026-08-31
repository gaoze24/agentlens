# AgentLens component overview

This is the source-code map, not a second submission diagram or startup guide.
Use the [one-page architecture](ONE_PAGE_ARCHITECTURE.md) for the visual summary,
[GLASS_BOX.md](GLASS_BOX.md) for trace implementation details, and the
[runbook](RUNBOOK.md) for reproduction.

## Components and ownership

| Component | Responsibility | Source |
| --- | --- | --- |
| React Playground | Agent lifecycle, prompts, Run history, live trace and comparison | [App.tsx](../apps/web/src/App.tsx) |
| Fastify API | Validation, optional shared-token gate, trace/audit routes and static UI | [app.ts](../apps/server/src/app.ts) |
| AgentService | Run state, runner invocation, trace ownership and restart reconciliation | [agent-service.ts](../apps/server/src/agent-service.ts) |
| Trace pipeline | Pair observed events, redact payloads, attach identity and bound history | [trace.ts](../apps/server/src/trace.ts) |
| Audit layer | Usage/duration summaries, estimated cost and versioned export | [audit.ts](../apps/server/src/audit.ts) |
| JSON store | Serialized writes and atomic replacement; one server process only | [store.ts](../apps/server/src/store.ts) |
| Workspace manager | Agent directories and deletion archives | [workspace.ts](../apps/server/src/workspace.ts) |
| Runtime adapters | Execute/resume Codex and report observed events | [runner-factory.ts](../apps/server/src/runner-factory.ts) |

The shared interfaces live in [types.ts](../apps/server/src/types.ts). Agent CRUD,
workspace/session persistence and runtime launchers are inherited Starter Kit
components; the trace/audit layer instruments that existing path.

## Execution and evidence flow

1. A browser request passes validation and the shared-token hook when configured.
   `/api/health` and `/api/auth` remain public; the token is not user identity.
2. `AgentService.executeRun` persists a root span before invoking the runtime.
   One Agent can have only one active Run.
3. Codex calls the configured Ark Responses-compatible endpoint and performs
   workspace actions. The adapter reports its observed JSON events.
4. A live trace writer pairs events and queues storage writes. The queue drains
   before terminal trace replacement, preventing late writes from restoring
   stale live spans. Observed policy denials request runtime cancellation.
5. The browser polls stored evidence during a Run and reads it afterward. The
   UI enables JSON export when the Run is terminal; export re-applies redaction.

Run completion and tool success are distinct: a model may finish after a command
fails. Non-zero tool exit codes are not consistently classified as error spans.
See the [demo](submission/DEMO.md) for a controlled cancellation/recovery case.

## Runtime profiles

| Profile | API | Codex | Physical boundary |
| --- | --- | --- | --- |
| Local POC | Host Node process | Disposable container per turn | Selected workspace and shared Codex-state mounts, configured UID/resource limits |
| Windows Compose / ECS | Application container | Child process in that same container | Shared application container, not independent per-Agent isolation |
| Direct development | Host Node process | Host process unless explicitly configured otherwise | No outer container; use only trusted demo tasks |

`CodexRunner` implements process execution; `ContainerCodexRunner` implements
the independent-container path. Both bound observed output/time and request
termination, but process cancellation is not a guarantee of descendant-process
cleanup. Only the local POC launcher probes Landlock and may fall back inside
its disposable runtime container. The Compose image has no such automatic probe.

## Persistence and recovery

The configured data directory contains `launchpad.json` with Agent, message,
Run and trace records. Workspace and Codex-state directories are separate
configured paths; their concrete locations differ by profile and are listed in
the [runbook](RUNBOOK.md). Deleting an Agent removes its platform records and
archives its workspace beneath `.deleted`.

Startup reconciles active Runs as cancelled and closes unfinished spans. Legacy
identity backfills persist once with provenance rather than substituting today's
Agent version/session. Full lifecycle, retention and migration details belong in
[GLASS_BOX.md](GLASS_BOX.md#span-lifecycle-and-crash-recovery).

## Trust boundary

Runtime output is untrusted. Trace and audit processing redact configured
secrets and recognized credential shapes, but ordinary chat records and generated
files are not all sanitized. A provider key is supplied to the runtime through
its environment, so an Agent may attempt to print it; environment delivery is
not a guarantee that it can never enter an event or output.

The UI configuration does not intentionally expose the provider key. Shared-token
authentication, observational policy and ordinary containers do not provide
multi-tenant security or comprehensive protection against exfiltration.
See [SECURITY.md](../SECURITY.md) for safe-use guidance.
