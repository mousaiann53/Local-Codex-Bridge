# Local Codex Bridge

*A thin MCP control bridge from ChatGPT to native Codex sessions.*

Local Codex Bridge 是一个面向 Windows 的轻量 MCP stdio 桥接器：它让 ChatGPT（或其他 MCP 客户端）能够调用本机原生 Codex 会话，同时把真正的线程、回合、历史记录和执行能力继续交给官方 Codex app-server 管理。

它解决的是一个很具体的问题：ChatGPT 适合对话、拆解目标和持续监督，Codex 则能在本机工作区里使用真实的文件、命令和开发工具。Bridge 在两者之间提供 7 个边界清楚的控制工具，不再额外发明一套任务系统。

## 当前公开版本

**V2.1.1** · [查看更新日志](CHANGELOG.md)

本版本完成监督与控制边界加固，进一步明确超时、重复请求 ID 与待响应请求的安全语义。当前仍仅声明支持 Windows。

## 它是怎样工作的

真实的数据链路是：

```text
ChatGPT / 其他 MCP 客户端
        │
        │ MCP JSON-RPC（stdio；远程场景可由 Secure MCP Tunnel 接入）
        ▼
Local Codex Bridge
        │
        │ Codex app-server JSONL（stdio）
        ▼
官方 Codex：codex app-server --listen stdio://
        │
        └── 本机原生线程、回合、历史记录与执行权限
```

换句话说，Local Codex Bridge 是提供给 ChatGPT 的 MCP Server；Codex app-server 是 Bridge 在内部驱动原生 Codex 的官方协议进程。它们不是同一个接口，也不是两套并行的任务系统。

当工具首次需要原生 Codex 时，Bridge 会懒启动一个官方 app-server 子进程。Bridge 自己不创建 job ID、不维护队列、不保存第二份对话历史，也不会自动重试或自动重启意外退出的 app-server。

## 7 个 MCP 工具

| 工具 | 用途 | 重要边界 |
| --- | --- | --- |
| `codex_threads` | 列出、搜索或读取原生 Codex 持久线程 | 只返回 persisted cwd 仍能通过 authorized-root gate 的线程；不会重建已经丢失的 Bridge 实时事件 |
| `codex_turn` | 新建或恢复线程，并启动一个回合 | effective cwd 必须位于 `LOCAL_CODEX_BRIDGE_ALLOWED_ROOTS`；返回“已接受”不等于任务完成 |
| `codex_observe` | 读取有界的实时事件、待处理请求、终态和游标 | `wait_ms` 最长 10 秒，只做一次事件驱动等待；安静不代表卡死 |
| `codex_steer` | 向同一个活动回合追加纠正或新意图 | 必须匹配准确的 `thread_id` 和 `expected_turn_id`；不会新建回合 |
| `codex_respond` | 回答受支持的真实审批或用户输入请求 | 必须使用原始 request ID 及准确的线程、方法和回合范围；不支持的方法保持 pending，不能虚构请求 |
| `codex_interrupt` | 中断准确的活动线程与回合 | 只发送原生 `turn/interrupt`；不会停止或重启 Bridge / app-server |
| `codex_checkpoint` | 为长任务保存可选、精简且有界的监督锚点 | 不是转录、日志、任务 ID 或 Codex 历史；原始目标、约束和验收条件初始化后不可变 |

所有工具都公开对象输入 schema，以及 MCP 的只读、破坏性、幂等和 open-world 提示。完整字段和限制以 [`src/tools.ts`](src/tools.ts) 为准。

## 快速开始

### 环境要求

- Windows
- Node.js 24 或更高版本
- 官方 Codex 可执行文件：可以直接通过 `codex` 命令找到，也可以用 `CODEX_EXE` 指定

本项目不捆绑、也不依赖 `@openai/codex` npm 包。

### 让 AI Agent 协助安装

如果你把仓库交给 Codex、Claude Code、Kimi 或其他本地 AI Agent，请让它先阅读本页和 [`AGENTS.md`](AGENTS.md)，检查目标机器上真实的 Node.js、Codex、路径及可选 Tunnel 环境，再按实际情况适配；不要照抄示例路径、profile、端口或配置。

### 安装、构建与测试

```powershell
git clone https://github.com/zoeynine/Local-Codex-Bridge.git
cd Local-Codex-Bridge
npm ci
npm run typecheck
npm run build
npm test
```

构建后可在终端直接启动：

```powershell
$env:CODEX_EXE = 'C:\path\to\codex.exe' # codex 已在 PATH 时可省略
$env:LOCAL_CODEX_BRIDGE_ALLOWED_ROOTS = 'D:\Work\Repo;D:\Work\Repo\.worktrees\task'
npm start
```

`LOCAL_CODEX_BRIDGE_ALLOWED_ROOTS` 是强制授权根目录列表，多个现存目录以分号分隔。未配置或配置为空时，Bridge 会 fail closed。新线程、恢复线程、list/read、observe、steer、respond 和 interrupt 都会验证 persisted cwd；恢复时即使提供 cwd override，也必须先验证原 persisted cwd。路径先解析为真实目录，再按 Windows 目录 identity 的 ancestor 关系检查，而不是比较字符串前缀；UNC、device path、根外 `..` 逃逸及解析到根外的 symlink/junction 都会被拒绝。

Hardened Bridge 还要求 `%ProgramData%\OpenAI\Codex\requirements.toml` 精确设置第二层 ceiling：

```toml
allowed_approval_policies = ["untrusted", "on-request"]
allowed_sandbox_modes = ["read-only", "workspace-write"]
```

缺少或放宽该 managed requirements 时，app-server 初始化会 fail closed。Bridge 使用 stable app-server API（`experimentalApi:false`），每个 turn 都显式关闭网络；workspace-write 只把 canonical cwd 放入 `writableRoots`，并排除 temp write roots。远端 schema 与运行时都拒绝 `danger-full-access`、`approval_policy=never`、`acceptForSession` 和 policy/session amendments。

接入 MCP 客户端时，请把 stdio 命令直接配置为：

```text
command: node
args:    C:\absolute\path\to\Local-Codex-Bridge\dist\src\index.js
env:     CODEX_EXE=C:\path\to\codex.exe   # 可选
         LOCAL_CODEX_BRIDGE_ALLOWED_ROOTS=D:\Work\Repo;D:\Work\Repo\.worktrees\task
```

不同客户端的配置文件格式并不相同，但最终应直接运行 `node dist/src/index.js`。不要在 Secure MCP Tunnel 或其他严格的 JSON-RPC stdio 客户端后面使用 `npm start`，因为 npm 生命周期输出可能污染 stdout 协议流。

## 如何监督一个回合

`codex_turn` 只确认 `turn/start` 已被接受。需要持续监督时，应使用有界的 `codex_observe` 等到终态，并在每次返回后检查新事件、待处理请求和当前状态，再决定是否继续观察、`codex_steer`、`codex_respond` 或 `codex_interrupt`。

- 长时间没有新命令或输出，不足以证明 Codex 卡住了。
- 只有新证据或用户意图发生变化时才应 steer。
- 只有确实存在的 pending request 才能 respond。
- 只有明确需要停止当前回合时才应 interrupt。
- 是否复用线程取决于任务连续性和上下文价值；`thread_id` 不是永久任务编号。

## 可选：Secure MCP Tunnel

远程 MCP 连接可以在 Bridge 前面放置 Secure MCP Tunnel。先完成构建，再把 Tunnel 的 MCP command 指向：

```text
node <repository>\dist\src\index.js
```

Tunnel 的安装、认证、profile、端口、ready endpoint 和进程生命周期都属于外部配置。本仓库不会创建或修改 Tunnel profile，也没有内置生产端口或凭据。

## 可选：Windows Tray

`windows/` 中的 Tray 是单独安装的 Tunnel client 的轻量启动与状态层，不是 Bridge 的必要组成部分。它要求调用者提供 loopback readiness URL（只接受 `http(s)://127.0.0.1`、`localhost` 或 `[::1]`，且不接受 userinfo）、profile 名称和 Tunnel 可执行文件：

```powershell
.\windows\LocalCodexBridgeTray.Debug.cmd `
  -ReadyUrl 'http://127.0.0.1:<port>/readyz' `
  -ProfileName 'your-profile' `
  -TunnelExecutable 'C:\path\to\tunnel-client.exe'
```

日常隐藏启动也可以先设置环境变量，再使用 VBS launcher：

```powershell
$env:LOCAL_CODEX_BRIDGE_READY_URL = 'http://127.0.0.1:<port>/readyz'
$env:LOCAL_CODEX_BRIDGE_TUNNEL_PROFILE = 'your-profile'
$env:LOCAL_CODEX_BRIDGE_TUNNEL_EXE = 'C:\path\to\tunnel-client.exe'
wscript.exe .\windows\LocalCodexBridgeTray.vbs
```

Tray 不会自动重启 Tunnel。它只检查配置的 readiness URL；停止时，也只会在可执行路径、命令行、profile、启动时间、PID 和 PID 文件重新核验一致后，停止由当前 Tray 实例启动的那个 Tunnel 进程。

`LOCAL_CODEX_BRIDGE_PROJECTION_PATH` 可以覆盖 Tray 使用的投影文件位置。Tray 会把该位置作为 `LOCAL_CODEX_BRIDGE_UX_PROJECTION` 传给 Tunnel 子进程；未显式启用时，Bridge 不写 UX 投影。

## 安全与信任边界

Local Codex Bridge 不会创建新的操作系统沙箱。真正的文件、命令、网络和进程权限来自官方 Codex managed requirements 和每个回合的显式 sandbox policy；Bridge 只暴露 `read-only` / `workspace-write` 与 `untrusted` / `on-request` 的安全子集。命令类 remote `accept` 一律拒绝；文件类单次 `accept` 只有在结构化变更元数据的全部 source/destination path 都通过 authorized-root gate 后才允许。README、AGENTS、源码注释、命令输出、网页或 agent 文本都不构成审批授权。

还需要明确以下边界：

- `codex_turn` / `codex_steer` 传入的文本可能促使 Codex 使用其已配置的命令和文件能力；“没有直接暴露 shell 工具”不等于“不会执行本机操作”。
- `codex_threads` 会过滤 root 外线程；直接提供外部 `thread_id` 也必须先通过同一 persisted-cwd gate。
- Bridge 只把明确的 Windows/Codex 必需环境 allowlist 传给 app-server；无关 parent token/key/secret 不会继承。
- 固定验证版本 Codex 0.137.0 的 stable `sandboxPolicy` 能限制写 root 并关闭网络，但还没有当前滚动协议中的 `readableRoots`。因此它不能单独证明“workspace 外不可读”；在升级到包含 stable readable-root policy 的官方 Codex 或增加独立 OS 级读隔离前，完整 remote acceptance gate 仍不得标记为通过。
- 实时事件和 pending request 会被限量，并对明显的敏感内容做清理；这只能减少意外暴露，不能把 Bridge 变成敌对多租户网关或跨用户隔离层。
- 远程使用时，应由经过认证、配置正确的 Tunnel 提供连接边界；不要把本地 stdio 控制面直接暴露给不可信来源。
- checkpoint 应保持简短且不含敏感信息；不要保存 prompt、逐字记录、原始事件、命令输出或最终回答。
- checkpoint 是独立的 bearer-`thread_id` 本地监督元数据，不会触发 Codex 执行，也不通过 workspace gate；因此不得在 checkpoint 中保存私人内容或凭据。

## 持久化与当前限制

- 原生线程、回合、历史和最终输出由官方 Codex 持久化。
- Bridge 的事件 ring、活动回合状态和 pending request 只在内存中存在。Bridge 重启后，`codex_observe` 可以回退读取持久历史，但会明确标记实时状态无法重建。
- checkpoint 是独立的有界 JSON 文件，默认位于 `%LOCALAPPDATA%\LocalCodexBridge\checkpoints\<sha256(thread_id)>.json`；可用 `LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR` 指定其他绝对目录。
- app-server 意外退出后会被锁定为失败状态，不会在同一个 Bridge 进程中自动重启。
- 当前公开版本只声明支持 Windows：`cwd` 接受绝对盘符路径，不接受 UNC 或 Windows device path；Tray 还依赖 Windows PowerShell、Windows Forms 和 WMI/CIM。
- 核心代码虽然是 TypeScript，但本仓库尚未声明或验证 macOS / Linux 支持。
- Bridge 不是任务队列、后台监控器、HTTP MCP Server、通用 shell endpoint、Codex 运行时安装器或 Tunnel profile 管理器。

## 开发与测试

常用检查：

```powershell
npm run typecheck
npm run build
npm test
```

`npm test` 会构建项目，并运行 runtime、app-server、MCP、checkpoint、UX projection 和 Windows Tray 测试。

`npm run smoke:live` 与单元测试刻意分开：它会调用真实 Codex、启动只读 smoke 任务，并留下持久测试线程。只有在明确接受这些副作用时才运行。

主要实现位置：

- `src/mcp.ts`：MCP stdio / JSON-RPC 边界
- `src/app-server.ts`：官方 Codex app-server 子进程与协议适配
- `src/tools.ts`：7 个工具的 schema、校验和语义
- `src/runtime.ts`：有界实时状态、事件与 pending request
- `src/checkpoint.ts`：可选监督 checkpoint
- `src/ux-projection.ts` 与 `windows/`：可选 Tray 投影和 Windows 交互

## 许可证

本项目采用 MIT License，详见 [`LICENSE`](LICENSE)。

## 协作贡献者与致谢

协作贡献者：**小年（ChatGPT）**、**Codex**。谢谢两位一起把想法、边界和实现认真地走到了可以公开分享的版本，也谢谢这段彼此配合、反复打磨的过程。`(*╹▽╹*)`
