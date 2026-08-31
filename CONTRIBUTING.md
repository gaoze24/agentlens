# Contributing

Keep changes focused, reproducible, and suitable for a three-day student
hackathon.

## Setup

For a real Agent demo, start with the [reviewer runbook](docs/RUNBOOK.md).
It documents the container profiles, credentials, data locations and shutdown.
Windows users can use the [PowerShell guide](docs/RUNBOOK.zh-CN.md).

For source development, install Node.js 22+ and npm 10+, then `npm ci`.
`npm run dev` starts Vite and the API with watch mode. The API reads the
**process environment**, not the repository `.env`; Vite loading frontend env
files does not configure the backend. Never put model secrets in `VITE_*` values.

The following starts a loopback-only development UI **without model execution**.
Use a fresh terminal and close it afterward to discard these environment values.

```bash
npm ci
export NODE_ENV=development HOST=127.0.0.1 PORT=3000
export APP_DATA_DIR="$PWD/.local/dev/data"
export AGENT_WORKSPACE_ROOT="$PWD/.local/dev/workspaces"
export CODEX_HOME="$PWD/.local/dev/codex-home"
export ARK_API_KEY= ARK_MODEL= APP_AUTH_TOKEN=
npm run dev
```

PowerShell equivalent:

```powershell
npm ci
$env:NODE_ENV = 'development'
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
$env:APP_DATA_DIR = Join-Path $PWD '.local/dev/data'
$env:AGENT_WORKSPACE_ROOT = Join-Path $PWD '.local/dev/workspaces'
$env:CODEX_HOME = Join-Path $PWD '.local/dev/codex-home'
$env:ARK_API_KEY = ''
$env:ARK_MODEL = ''
$env:APP_AUTH_TOKEN = ''
npm run dev
```

Open <http://localhost:5173/>; Vite proxies `/api` to port 3000. Stop with Ctrl+C.
For populated evidence without credentials, use the runbook's isolated fixture
profile instead. For real runtime development, explicitly provide backend model
variables and configure a runner; the POC launcher builds/probes the container
runtime, whereas `npm run dev` does not. The default `local-process` runner would
execute Codex on the host, so do not use it for untrusted tasks or disable its
sandbox. Prefer the documented independent-container POC for rehearsals.

## Validate

```bash
npm run check
```

This checks types, fixture-based tests and builds, not a live model. On Bash
with curl and Node, `npm run verify:evidence` verifies exported fixtures over a
temporary HTTP server and cleans it up. If changing deployment files, also run
`terraform fmt -check -recursive deploy/volcengine` and
`docker compose config --quiet` with an existing configured `.env`.
Do not publish the expanded Compose configuration: it includes private values.

## Pull requests

- Explain the behavior and reason for the change.
- Add tests for API, lifecycle, persistence, or Runtime changes.
- Update English documentation and `.env.example` when configuration changes.
- Use GitHub Flavored Markdown and relative repository links.
- Keep startup procedures in the runbooks, demo steps in
  [DEMO.md](docs/submission/DEMO.md), and trace implementation details in
  [GLASS_BOX.md](docs/GLASS_BOX.md). Link rather than copy long procedures.
- Treat [archived challenge drafts](docs/archive/starter-kit/README.md) as
  historical references, never as current submission rules.
- Never commit credentials, local state, workspaces, build output, or Terraform
  state.
- Report security issues according to [SECURITY.md](SECURITY.md).
