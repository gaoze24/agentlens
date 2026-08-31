# AgentLens：完整运行、验证与停止步骤（Windows）

适用：Windows + Docker Desktop + PowerShell。下文先给出已配置环境的快捷步骤，再说明从零准备的方法。录制顺序见[统一演示脚本](submission/DEMO.md)。

## 0. 已配置电脑：最短启动路径

1. 打开 Docker Desktop，等左下角显示 **Engine running**。只打开窗口但引擎未就绪时，后续命令仍会失败。
2. 在 PowerShell 中进入 `agentlens` 仓库目录。可以从资源管理器打开该文件夹，再在地址栏输入 `pwsh` 或 `powershell`。
3. 执行：

```powershell
docker compose config --quiet
docker compose up --build -d launchpad
docker compose ps
```

4. 若 `.env` 按本指南配置了 `PUBLIC_PORT=127.0.0.1:4242`，打开 **http://127.0.0.1:4242/**。模板默认端口为 3000，应以实际配置为准。
5. 如出现解锁页面，输入 `.env` 的 `APP_AUTH_TOKEN`，**不是** `ARK_API_KEY`。

此快捷路径假设 `.env` 已配置好模型凭证、访问口令及 Compose 的 `local-process` 模式。尚未配置时请先完成第 1-3 节；不要覆盖已有文件，也不要把 key 发到聊天中。

停止：

```powershell
docker compose stop launchpad
```

下面是给新电脑、队友和排错使用的完整流程。

## 1. 准备工具

- 安装 Git 和 Docker Desktop，启用 Linux containers。
- Windows 虚拟化/WSL 2 必须满足 Docker 要求；遇到 Virtualization support not detected 时，先解决 BIOS/UEFI 虚拟化和 WSL，不要靠 Docker 登录解决。
- 确认 Docker 有足够内存。当前 Compose 配置给应用容器的上限是 4 GB。
- 使用 Compose 启动时，宿主机不需要安装 Codex CLI 或 Node.js；它们由镜像提供。只有执行本地 `npm run check`、无凭证展示或源码开发时，才需要 Node.js 22+ 与 npm 10+。

[Docker Desktop Windows 安装要求](https://docs.docker.com/desktop/setup/install/windows-install/)

```powershell
git --version
docker version
docker compose version
```

`docker version` 应同时返回 Client 和 Server；若只有 Client 或提示连接不到 Docker，先启动引擎。

## 2. 取得正确的代码

新电脑：

```powershell
git clone https://github.com/gaoze24/agentlens.git
Set-Location agentlens
```

已有目录：先执行 `git status`。只有在没有未保存改动、确实准备切到主分支时，再执行：

```powershell
git switch main
git pull --ff-only upstream main
```

上面适用于 `origin` 是个人 fork、`upstream` 是 `gaoze24/agentlens` 的目录。直接克隆 gaoze24 仓库时，使用 `git pull --ff-only origin main`。可用 `git remote -v` 确认；如果没有 `upstream`，不要盲目执行或覆盖已有 remote。

如需运行某个 PR 或已提交的版本，请按该版本的说明选择分支；仅为启动应用不必切换现有工作分支。

## 3. 配置环境（新安装才做）

不要覆盖已有 `.env`：

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
notepad .env
```

确认或填写下列项目；下面的占位值不能原样运行：

```dotenv
PUBLIC_PORT=127.0.0.1:4242
APP_AUTH_TOKEN=YOUR_RANDOM_DEMO_ACCESS_TOKEN
ARK_API_KEY=YOUR_PRIVATE_ARK_MODEL_KEY
ARK_MODEL=YOUR_RESPONSES_COMPATIBLE_MODEL_OR_ENDPOINT
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
RUNTIME_PROVIDER=local-process
CODEX_SANDBOX_MODE=workspace-write
```

- `APP_AUTH_TOKEN`：给浏览器解锁的共享演示口令，至少 24 个 URL-safe 字符，不能以 `replace-` 开头。可以用 `[guid]::NewGuid().ToString('N')` 生成一个，再私下粘贴到 `.env`；不要在录屏时显示。
- `ARK_API_KEY`：模型 API key，不是账户 AK/SK；不要和访问口令混淆。
- `ARK_MODEL`：具有 **Responses API** 能力的 model/endpoint ID。仅证明 chat/completions 可用还不够。
- `ARK_BASE_URL`：与你的服务商、账号区域和模型一致。北京地址只是仓库默认值，不要给不同服务商的 key 机械套用。
- `PUBLIC_PORT=127.0.0.1:4242`：限制本机访问。默认模板的 `3000` 会得到不同的地址。
- Compose 会把内部数据路径设置为 `/app/data`、`/app/workspaces`、`/app/codex-home`，不要把它们改成本机 Windows 路径。
- Compose 使用 `local-process`，意思是 **Codex 运行在应用容器内部**，不是你的 Windows 宿主机。不要把它改成 `container`：当前 Compose 没有配置 Docker socket 或容器内 Docker CLI。

`.env` 已被 Git 忽略。不要上传它、公开完整容器环境，或在共享终端中输出 `docker compose config` 的展开结果；校验使用下面的 `--quiet`。

## 4. 构建并启动

```powershell
docker compose config --quiet
docker compose up --build -d launchpad
docker compose ps
```

第一次会下载基础镜像、依赖并构建前后端，需要网络和一定时间。修改源码后也应带上 `--build`。

检查健康接口：

```powershell
Invoke-RestMethod http://127.0.0.1:4242/api/health
```

预期 `ok` 为 `true`。这只能证明 Web/API 已启动，不能证明模型连接成功。

查看排错日志：

```powershell
docker compose logs --tail 100 launchpad
```

日志可能包含原始运行内容，分享前要检查。`docker compose logs -f launchpad` 的 Ctrl+C 仅退出日志跟随，不停止后台服务。

## 5. 打开与解锁

浏览器进入 http://127.0.0.1:4242/，输入 `APP_AUTH_TOKEN`。刷新后可能需要重新解锁，因为口令只保存在页面进程内存中。

你也可以从 Docker Desktop 的 Containers 中找到 `launchpad` 服务查看运行状态。`restart: unless-stopped` 意味着容器可随 Docker 重启恢复；暂时不用时请明确执行停止命令。

## 6. 验证真实功能

### A. 正常执行

创建一个新的演示 Agent，只给它一个空白测试工作区。发送：

```text
Create hello.js that prints "AgentLens demo". Create hello.test.js using Node's built-in node:test module, run node --test, then run node hello.js. Use no external dependencies or network downloads. Summarize the files and results.
```

检查：

- Run 从运行中进入完成状态，且实际产生模型回复。
- 运行中打开 **Watch trace live**，看到实际事件；完成后查看 Trace。
- 展开工具步骤，确认确实执行了命令，而不仅是模型声称已执行。
- 本机 `workspaces\<Agent UUID>\` 出现生成的文件。
- 再发一个引用前面文件的小任务，确认会话及工作区可继续使用。

### B. 可控的取消与恢复

发送一个仅用于测试等待与停止的任务：

```text
Run node -e "setTimeout(() => console.log('wait finished'), 60000)" in the workspace, wait for it to finish, and then report the result. Do not start it in the background.
```

在 Trace 中确认长命令已开始后按 Agent 的 **Stop**：

- 预期 Run 为 `cancelled`，Agent 为 `stopped`。
- 查看保留下来的 Trace：根步骤、Runtime 和未结束步骤应已收尾，而不是继续增长。
- 按 **Start**，再发送 `Run node hello.js again and report its output.`，确认平台仍可使用。

模型可能不完全遵循提示词，必须现场观察。取消在 Compose 中主要针对 Codex 进程；它不是任意子进程树都被彻底清理的安全保证。如果任务疑似仍在运行，停止应用容器可结束该容器内的进程。

**工具测试失败不等于 Run 失败**。非零命令退出码目前并非都被标为 error；不要把它当作确定的失败录屏脚本。取消/恢复也是题目认可的异常场景。

### C. 历史、比较和导出

进入 **Runs**，选择两个实际执行的 Run，查看状态、耗时和 token，再 **Compare runs**。

完成后 **Export JSON**。如果本机安装了 Node.js，可在仓库目录运行：

```powershell
node scripts/verify-audit.mjs "C:\path\to\downloaded-audit.json"
```

将示例路径换成实际下载文件。正常情况下显示 `OK`。不要在演示中使用真实密钥测试脱敏；用虚构数据或自动测试。

费用默认显示 **Not priced**，这是正常行为。如需演示估算价格，在 `.env` 配置真实、核实过的每百万 token 价格并重新创建服务，不要随意填数字冒充实际费用。

## 7. 数据和文件在哪里

| 内容 | Compose 模式下的宿主机位置 |
| --- | --- |
| Agent 生成的文件 | `agentlens\workspaces\<Agent UUID>\` |
| Agent、聊天、Run、Trace 元数据 | `agentlens\data\launchpad.json` |
| Codex 配置与会话状态 | `agentlens\codex-home\` |
| 删除 Agent 后归档的工作区 | `agentlens\workspaces\.deleted\` 下 |
| 浏览器导出 | 浏览器设置的下载目录 |

UUID 是 Agent ID，不是显示名称。删除 Agent 会删除其平台记录，但工作区按现有策略归档。不要在运行时手动改 JSON 数据文件。备份应先停止服务，再复制以上三个状态目录。

这些目录可能包含任务原文、输出和工作文件，**不是都经过脱敏的审计导出**。不要打包整个目录公开提交，也不要把生产资料放进演示工作区。

## 8. 停止、重开、升级

停止服务并保留容器与数据：

```powershell
docker compose stop launchpad
```

重开现有容器（没有修改配置/代码时）：

```powershell
docker compose start launchpad
```

改了源码、`.env` 或 Compose 配置后：

```powershell
docker compose up --build -d launchpad
```

移除服务容器和项目网络，但保留宿主机绑定目录：

```powershell
docker compose down
```

不要删除 `data`、`workspaces` 或 `codex-home`，也不要使用 prune/删除卷作为日常停止方法。只关网页或 PowerShell 窗口不会停止 `-d` 启动的服务。

## 9. 常见问题

| 现象 | 排查方式 |
| --- | --- |
| 找不到 docker 命令 | 安装 Docker Desktop 后重新打开 PowerShell，检查 PATH |
| 找不到 dockerDesktopLinuxEngine / 无法连接 daemon | Docker 引擎未运行，或当前容器模式不正确；先在 Desktop 等待 Engine running |
| 网页打不开 | 查看 compose ps、logs；确认使用 PUBLIC_PORT 对应地址，没有其他进程占用端口 |
| 浏览器 401 / 解锁失败 | 使用 APP_AUTH_TOKEN，不是模型 key |
| Run 中 Ark 401/403 | 核对 provider、key、权限、区域、模型 ID；模型侧 401 与页面解锁 401 不同 |
| /responses 不可用 | 所选模型或 endpoint 必须支持 Responses API，不只是 chat/completions |
| Model metadata not found | 若后续模型请求和任务成功，通常是元数据回退警告，不等于模型调用失败 |
| Landlock/sandbox 报错 | Compose 当前没有自动降级探测；优先使用 WSL/Linux 的独立 Runtime 路径，不要在宿主机上禁用沙箱 |
| 拉取镜像或 apt/npm 失败 | 检查 Docker 的网络/代理与可信镜像源；不是应用业务错误 |
| 找不到历史数据 | Compose 使用 data；npm run poc 默认使用 .local（macOS 通常位于用户目录），不同模式不自动共用数据 |

如果必须在隔离的 Compose 演示容器内临时使用 `CODEX_SANDBOX_MODE=danger-full-access`，要先理解：Agent 可能访问这个应用容器里的共享数据和模型环境变量。这不提供每个 Agent 的文件隔离。只使用空测试数据、专用低权限凭证，不挂载其他目录；不要把这一做法套到直接运行于宿主机的 Codex。

## 10. 可选：自动测试与无凭证展示

在装有 Node.js 22+ 的宿主机中：

```powershell
npm ci
npm run check
```

它检查类型、测试和构建，不会启动长期运行的应用服务，也不需要真实模型凭证。

想先浏览模拟 Trace 而不调用模型，可在新的 PowerShell 窗口中执行（与 Compose 分开）：

```powershell
npm ci
npm run build
$env:APP_DATA_DIR = Join-Path $PWD '.local/fixture-review/data'
$env:AGENT_WORKSPACE_ROOT = Join-Path $PWD '.local/fixture-review/workspaces'
$env:CODEX_HOME = Join-Path $PWD '.local/fixture-review/codex-home'
$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = '4243'
$env:ARK_API_KEY = ''
$env:ARK_MODEL = ''
$env:APP_AUTH_TOKEN = ''
node scripts/seed-demo.mjs
node apps/server/dist/index.js
```

浏览 http://127.0.0.1:4243/，查看已有 fixture Run。这个进程**不自动加载 `.env`**，这里明确设置了所需变量。无法执行新的真实模型任务是预期行为。停止时在该终端按 Ctrl+C，然后关闭窗口以丢弃本次环境变量。

如果 seed 提示已存在 Agent，直接启动服务查看旧 fixture 即可；不要加 `--force` 覆盖已有数据。这种 fixture 浏览不能替代比赛要求的真实 Agent 演示。

## 11. 评审推荐：Linux/macOS 独立 Runtime

见 [英文运行指南](RUNBOOK.md)。`npm run poc` 是 Bash 脚本，不应直接复制为 PowerShell 命令；需要 WSL/Linux 或 macOS 环境。它每次运行一个独立容器，而 Compose 是共享应用容器，两者的隔离程度不同。

本指南按代码与 Compose 配置核对，不代表已经完成干净机器上的真实模型验收。录制前仍需按第 6 节验证最终提交版本。
