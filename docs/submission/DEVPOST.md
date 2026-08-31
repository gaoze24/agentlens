# AgentLens

## Tagline

See what your AI agent did, understand where a run broke, and export evidence you can inspect.

## Challenge

TikTok TechJam 2026 - Agent Launchpad: Design and Build Lightweight Agent Middleware.

Middleware focus: trace, audit, and observability (Glass Box).

## Inspiration

An agent's final answer is not an execution history. Between a user's request and that answer, an agent may call a model, edit files, execute commands, and encounter errors. A final status alone does not explain the sequence, the work already performed, or why a run stopped.

AgentLens addresses that visibility gap. We build on the provided Agent Launchpad rather than rebuilding its platform. Our contribution is a connected evidence layer around the existing execution path: a way for an operator to inspect a run while it happens, review its recorded actions afterward, and share a machine-readable audit bundle.

## What it does

AgentLens turns each run into a tree of correlated spans, linking the run, runtime invocation, and observed model and tool events. The browser shows a live-updating trace, a shared timeline, expandable event details, and filters that preserve the parent-child context.

Operators can browse run history, search and filter runs, compare two runs, and inspect reported token usage and elapsed time. When pricing is configured, the application also estimates cost using the supplied rates; otherwise it explicitly reports that the run is not priced.

An Export JSON action produces a versioned audit bundle containing the run, summary, and trace. Redaction covers configured secrets, recognized credential patterns, sensitive object properties, and JSON-encoded payloads. An independent command-line verifier checks the exported artifact's structure, timing, and credential indicators.

The trace also records observed command-policy decisions. These decisions help explain what the platform allowed or denied; they are not a claim of comprehensive sandbox security. Interrupted work remains inspectable: unfinished spans are closed at the run boundary, and startup reconciles runs left active after a server interruption.

## How we built it

The existing React Playground sends requests to a Fastify control plane. We instrumented `AgentService.executeRun` and the runner event callback so the root span exists before runtime execution and subsequent spans are persisted as events arrive. A serialized write queue drains before the final trace replacement to keep late live updates from resurrecting old spans.

Trace processing pairs `item.started` and `item.completed` events, propagates identity, redacts payloads, and bounds retained evidence. The audit layer summarizes the stored trace and applies redaction again during export. The browser reads these real backend records rather than inventing a separate UI-only timeline.

The runtime remains the Starter Kit's Codex CLI connected to a configured Ark Responses-compatible endpoint. The local POC profile runs each turn in a disposable Docker or Podman container. The Compose profile instead runs the API and Codex processes in one application container; we document this weaker, shared boundary explicitly.

## Challenges we addressed

The hardest part was making the evidence remain useful when execution did not finish cleanly. An unfinished step must not disappear or grow forever when viewed the next day. A secret crossing a preview-length boundary must be redacted before truncation. Older traces must remain readable without pretending that today's agent configuration is their historical configuration.

We added regression coverage for these cases, stable persisted identity backfills with explicit provenance, and verification of actual exported bundles. The verifier inspects decoded payloads independently of the producer's redaction implementation.

## What we are proud of

Our middleware is integrated at the execution boundary, not only in a dashboard. Live observation, historical inspection, policy evidence, and export all describe the same underlying run. Tests exercise successful, failed, cancelled, and policy-denied runs, along with migration and privacy edge cases.

The reviewed implementation passes `npm run check`: 125 server tests and 24 frontend tests, plus TypeScript checks and production builds. These are automated fixture-based results, not a benchmark of model quality or a production-security certification.

## What we learned

Observability is partly a data-integrity problem. A timeline is only as credible as its event relationships and timestamps; an audit download is only as safe as the data inside it. Making those assumptions explicit, and verifying the exported artifact independently, mattered more than adding another visual feature.

## Limitations and what's next

This is a single-user proof of concept, not a multi-tenant security boundary. Live updates use polling, persistence rewrites a JSON store, and prices are operator-supplied estimates. Redaction cannot reliably identify every unknown or encoded secret. Command policy is an asynchronous text denylist, not pre-execution approval.

A failed tool command can still be followed by a successful model response: run status and tool exit status are distinct, and non-zero command exits are not yet consistently promoted to error spans. We do not present that classification gap as solved. Next steps include more precise tool-outcome classification, streaming updates, stronger storage, historical rate snapshots, and clearer attribution and access controls.

## Team Contributions

- **Gao Ze — Project Setup & Core Architecture:** Initiated the project, established the foundational architecture and application scaffolding, and refined core functionality.
- **Jin Liangdong — Bug Fixes, Feature Iteration & Documentation:** Resolved bugs and security issues, implemented iterative feature improvements, and authored technical documentation.

## Built with

TypeScript, React, Vite, Node.js, Fastify, Zod, Vitest, Docker/Podman, Codex CLI, Ark Responses API, Git, npm, and GitHub Actions.

## Tools, APIs, and asset attribution

- Development and verification: Git, npm, Docker, Vitest, TypeScript, and Codex-assisted implementation and review.
- Model integration: a configurable Ark Responses-compatible endpoint; credentials remain operator-supplied and are not included in the submission.
- Foundation: the provided [RrankPyramid/CodeJam Starter Kit](https://github.com/RrankPyramid/CodeJam). Its UI, lifecycle, model connection, and runtime launchers are baseline infrastructure, not claimed as our invention. Retain the repository's MIT license and upstream attribution.
- Data and assets: synthetic run fixtures and application screenshots. No model-training dataset or model training is required. Fixture records are labelled as fixtures and do not replace a real end-to-end demonstration.

## Try it out

Source repository: https://github.com/gaoze24/agentlens

Start with `docs/RUNBOOK.md` for the reviewer setup, runtime-profile differences, validation steps, and shutdown commands. `docs/ONE_PAGE_ARCHITECTURE.md` links to the architecture diagram. A credential-free fixture mode is available for inspecting the trace UI; executing a new agent task requires a working model endpoint.
