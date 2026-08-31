# AgentLens - reviewer runbook

This guide distinguishes a real Agent run from credential-free fixture inspection. The application remains a single-user POC. Use an empty demo workspace and a dedicated model key, never production data.

For Windows setup and detailed troubleshooting, see [the Chinese Windows guide](RUNBOOK.zh-CN.md).
For recording, use the [single maintained demo script](submission/DEMO.md).

## 1. Choose a runtime profile

| Profile | Where the API runs | Where Codex runs | Requirements |
| --- | --- | --- | --- |
| Local POC, recommended for judging | Host Node process | Disposable container per turn | Linux/macOS, Node 22+, npm 10+, Docker or Podman |
| Windows Docker Compose | Application container | Process in that same container | Git, Docker Desktop with Linux containers, PowerShell |
| Fixture inspection | Host Node process | No Agent execution | Node 22+, npm 10+; no model key needed |

Compose is **not** per-Agent container isolation. Neither profile is a hardened multi-tenant sandbox. Do not switch Compose to `RUNTIME_PROVIDER=container`: its supplied image/volumes do not provision nested Docker access.

## 2. Get the source

```bash
git clone https://github.com/gaoze24/agentlens.git
cd agentlens
```

Use the team's submitted commit/branch if it differs from main. Do not overwrite an existing `.env` or use a dirty checkout as a clean-install test.

## 3A. Real Agent execution: Linux/macOS local POC

Run these commands in **Bash**, not PowerShell. Windows users can use an appropriately configured WSL Linux environment instead, installing Node/Git inside WSL and enabling Docker integration for that distro. Prefer a Linux filesystem checkout for that path.

```bash
node --version
npm --version
docker version
```

For Podman, check `podman info` and set `CONTAINER_ENGINE=podman` below; [engine setup details](LOCAL_POC.md#rootless-podman-on-linux) are documented separately. The engine must be running; Codex CLI is installed in the runtime image, not required on the host.

Install and verify:

```bash
npm ci
npm run check
```

Supply credentials privately. The POC script reads shell environment variables; **it does not load the repository `.env`**.

```bash
read -r -s -p 'Ark model API key: ' ARK_API_KEY
printf '\n'
export ARK_API_KEY
read -r -p 'Responses-compatible model/endpoint ID: ' ARK_MODEL
export ARK_MODEL
export HOST=127.0.0.1
export PORT=3000
export CONTAINER_ENGINE=docker
npm run poc
```

Set `ARK_BASE_URL` to the URL appropriate for the supplied provider/key/region if different from the repository default. A working Chat Completions request does not prove Responses API compatibility.

The script builds the runtime, checks mounts and Landlock support, builds the application, and starts it in the foreground. It may explicitly fall back to `danger-full-access` **inside the disposable runtime container** when Landlock is unavailable; that is not equivalent to a hardened sandbox. Do not reuse this setting for an uncontained host process.

Open **http://127.0.0.1:3000/**. If `APP_AUTH_TOKEN` was supplied, enter it in the browser unlock screen. It is a separate shared access token, not the Ark model key.

Stop with **Ctrl+C in the startup terminal**. The script cleans up its remaining runtime containers and retains application data. Restart with the same environment and `npm run poc`.

State locations:

- Linux default: `.local/data`, `.local/workspaces`, `.local/codex-home` beneath this checkout.
- macOS default: `~/.volc-agent-launchpad/{data,workspaces,codex-home}`.
- `LOCAL_POC_DATA_ROOT` selects a different shared state directory.
- Generated files are under the workspace directory's `<Agent UUID>` subdirectory.

## 3B. Real Agent execution: Windows Compose

Start Docker Desktop and wait for **Engine running** in Linux-container mode. [Docker's Windows setup requirements](https://docs.docker.com/desktop/setup/install/windows-install/) include virtualization/WSL prerequisites.

In PowerShell, from the repository root:

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
notepad .env
```

Set `ARK_API_KEY`, `ARK_MODEL`, and the appropriate `ARK_BASE_URL`. Set `APP_AUTH_TOKEN` to a newly generated URL-safe value of at least 24 characters, not a `replace-` placeholder. Keep `RUNTIME_PROVIDER=local-process` and `CODEX_SANDBOX_MODE=workspace-write`.

For a local-only browser endpoint, set:

```dotenv
PUBLIC_PORT=127.0.0.1:4242
```

Then:

```powershell
docker compose config --quiet
docker compose up --build -d launchpad
docker compose ps
Invoke-RestMethod http://127.0.0.1:4242/api/health
```

Open **http://127.0.0.1:4242/** and unlock with `APP_AUTH_TOKEN`. The template default port is 3000; 4242 is the explicit configuration above. A healthy API is not yet proof that a model request succeeds.

Read logs with `docker compose logs --tail 100 launchpad`. Never share a full expanded Compose environment; it contains credentials. If Landlock fails, do not assume Compose has the POC script's automatic fallback. Prefer the independent-runtime path, or assess the weaker shared-container boundary before any sandbox downgrade.

Stop/restart:

```powershell
docker compose stop launchpad
docker compose start launchpad
```

After code or environment changes, use `docker compose up --build -d launchpad` to rebuild/recreate, rather than only restarting. `docker compose down` removes the service container and network but keeps the bind-mounted `data`, `workspaces`, and `codex-home` directories. Do not delete those directories or prune storage to stop the app.

Closing the browser or a log-following terminal does not stop a detached container. The Compose restart policy can restart an unstopped service when Docker starts again.

## 4. Verify a functional end-to-end run

Create a demo Agent from the frontend and send:

```text
Create hello.js that prints "AgentLens demo". Create hello.test.js using Node's built-in node:test module, run node --test, then run node hello.js. Use no external dependencies or network downloads. Summarize the files and results.
```

Confirm an actual model response, file creation in the workspace, and recorded command execution. During execution, open **Watch trace live**; afterward, inspect timestamps, status, tool payloads, and reported usage. Follow up by asking the Agent to run the same file again.

For a controlled interruption, ask the Agent to run a foreground Node command that waits for 60 seconds. Once the command actually starts, press **Stop**. Expect a cancelled Run and closed trace bounds; then **Start** the Agent and execute another harmless task. Inspect the result rather than assuming the model obeyed the requested waiting command.

In **Runs**, filter history, select two Runs, and compare summaries. Export a terminal Run and verify the downloaded artifact:

```bash
node scripts/verify-audit.mjs /path/to/downloaded-audit.json
```

Expected result: `OK`. Use synthetic secrets for privacy demonstrations, not a real provider key. No pricing configuration means **Not priced**, not zero cost.

**Known demo caveat:** a non-zero tool exit is not the same as a failed Agent Run, and current tool-exit classification is incomplete. A model may report a failed test and still complete its own turn. Do not promise a red failed Run solely by asking for a failing assertion. Cancellation/recovery provides a distinct, observable abnormal case.

## 5. Credential-free fixture inspection

This is useful for reviewing the UI and audit schema, **not a replacement for the required real Agent demonstration**. Use a fresh Bash terminal, separately from the real POC:

```bash
npm ci
npm run build
export APP_DATA_DIR="$PWD/.local/fixture-review/data"
export AGENT_WORKSPACE_ROOT="$PWD/.local/fixture-review/workspaces"
export CODEX_HOME="$PWD/.local/fixture-review/codex-home"
export NODE_ENV=production
export HOST=127.0.0.1
export PORT=4243
export ARK_API_KEY=
export ARK_MODEL=
export APP_AUTH_TOKEN=
node scripts/seed-demo.mjs
node apps/server/dist/index.js
```

Open http://127.0.0.1:4243/ and inspect the existing fixture Runs. New model execution is intentionally unavailable. Stop with Ctrl+C and close the terminal. If seed refuses an existing populated store, use the existing fixture or a fresh directory; do not overwrite it with `--force`.

## 6. Automated evidence and data handling

```bash
npm run check
```

This performs typechecks, fixture-based tests, and builds without a real model call. On Linux/macOS with Bash, curl and Node, `npm run verify:evidence` additionally starts a temporary test server, exports fixture bundles over HTTP, checks authentication, and shuts it down. It is not a test of a live model.

Metadata lives in the configured data directory's `launchpad.json`. Stop the app before backing up data, workspace and Codex-state directories together. Agent deletion archives workspace files under `.deleted` but removes its platform records.

Only the trace/audit paths apply the documented redaction. Conversation records and generated files may contain original user inputs and sensitive output. Do not publish raw state directories, model credentials, access tokens, or private files.

## Validation scope

These instructions were checked against source and Compose configuration. The
audit-fix revision (`4aa5e7b`, merged upstream) passed 149 automated tests plus
typechecks/builds. This documentation update does not certify a fresh-machine
live-model run; complete section 4 on the submitted revision before recording.
