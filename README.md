# Onit - Desktop AI Agent

> Open-source desktop AI agent. Use any model, any provider.
>
> 开源桌面端 AI Agent，自由调用任意模型。

---

## What is Onit? / 这是什么？

**Onit** is an open-source desktop AI agent for macOS and Windows. It brings the power of CLI-level code agents to a visual interface, so that anyone — regardless of technical background — can use natural language to accomplish everyday tasks: file management, code generation, data analysis, web research, and more.

**Onit** 是一款开源的桌面端 AI Agent 应用，支持 macOS 和 Windows。它将命令行 Code Agent 的通用能力带入可视化界面，让非技术背景的用户也能通过自然语言完成日常任务：文件管理、代码编写、数据分析、信息检索等。

---

## Why Onit? / 为什么选择 Onit？

Most desktop agent products lock you into a specific vendor — you have to buy credits, subscribe to their plans, and can only use their limited model selection. **Onit is different.**

市面上大多数桌面 Agent 产品都要求与开发厂商账号绑定，通过购买或订阅积分使用，模型可选范围极为有限。**Onit 不一样。**

### Model Freedom / 模型自由调用

Onit is not tied to any single AI provider. It supports mainstream **Coding Plans** (Qianfan, VolcEngine, Alibaba Cloud, etc.) and **direct API access** with your own keys. Switch freely between any provider and any model, for any task. Use what works best — and save money.

Onit 不绑定任何 AI 服务商。兼容市面主流 **Coding Plan**（百度千帆、火山方舟、阿里百炼等），同时支持 **API Key 直接调用**。所有任务均可在任意服务提供商、任意模型之间自由切换，按需选择，灵活且省钱。

### Extensible Skills / Skills 可扩展

Onit comes with a flexible Skills system — use built-in skills, create your own, or import from others. Agent capabilities grow with your needs.

Onit 内置灵活的 Skills 体系，支持内建、自建与导入三种方式，让 Agent 的能力边界按需扩展。

### Safe & Controllable / 安全可控

The agent represents you — it doesn't replace your decisions. Three permission modes let you choose how much autonomy to give:

- **Plan Mode** 🛡️ — Confirm every operation. Best for learning what the agent does.
- **AcceptEdit** ✅ — Smart confirmations for sensitive operations. Recommended for daily use.
- **Full Access** ⚠️ — Auto-execute everything. Use when you fully trust the task.

Agent 代表你行事，而不是取代你的决策。三种权限模式让你自由选择：

- **Plan Mode** 🛡️ — 逐步确认所有操作，适合了解 Agent 行为。
- **AcceptEdit** ✅ — 智能确认敏感操作，推荐日常使用。
- **Full Access** ⚠️ — 全自动执行，仅在完全信任任务时使用。

### Privacy Vision / 隐私愿景

Onit plans to bundle a local model deployment framework, running small on-device models so that all data stays on your machine — never leaves your device. Bringing full agent capabilities to privacy-conscious users.

Onit 计划打包本地模型部署框架，在用户设备上运行端侧模型，实现所有数据的本地闭环处理，数据不出设备，为注重隐私的用户提供完整的 Agent 能力。

---

## Core Philosophy / 核心理念

- **Transparent** — Every action the agent takes is visible to you. You see every file it reads, every command it runs.
- **Interruptible** — You can stop the agent at any time. You're always in control.
- **Environment-Aware** — The agent sees your real working context — open files, running apps, file system structure. It infers intent from your environment instead of asking you to explain everything.
- **Habit Learning** — The agent learns your preferences by observing your behavior — naming conventions, file organization, workflows — rather than asking you to fill out configuration forms.

- **透明** — Agent 的每一步操作对你完全可见，读了哪个文件、运行了什么命令，一目了然。
- **可中断** — 你可以随时停止 Agent，控制权始终在你手中。
- **环境感知** — Agent 能看到你的真实工作环境——打开的文件、运行的应用、文件系统结构，从环境中推断意图，而不是让你反复解释背景。
- **习惯学习** — Agent 通过观察你的行为来学习偏好——命名习惯、文件组织方式、工作流程——而不是让你填写配置表。

---

## Features / 功能特点

- **Multi-session support** — Run multiple agent sessions simultaneously, switch freely between them.
- **Built-in tools** — File read/write/edit/delete, directory listing, content search, command execution, task management.
- **Scheduled tasks** — Set up recurring tasks with cron-like scheduling.
- **Workspace (Working Place)** — Select a working directory as the agent's workspace, with permissions scoped to that folder.
- **File attachment** — Attach files directly to your conversation for the agent to analyze.
- **Streaming responses** — See the agent's thinking and actions in real-time.
- **Background execution** — Switch to another session while the agent works, get notified when it's done.
- **History search** — Full-text search across all your past conversations.

---

- **多会话支持** — 同时运行多个 Agent 会话，自由切换。
- **内置工具集** — 文件读写编辑删除、目录列表、内容搜索、命令执行、任务管理。
- **定时任务** — 设置周期性自动执行的任务。
- **工作区 (Working Place)** — 以文件夹为单位选择工作区，Agent 操作范围限定在工作区内，权限边界清晰可控。
- **文件附件** — 直接附加文件到对话中供 Agent 分析。
- **流式响应** — 实时查看 Agent 的思考过程和操作动态。
- **后台执行** — 切换到其他会话时 Agent 继续工作，完成后通知你。
- **历史搜索** — 跨所有历史对话的全文搜索。

---

## Tech Stack / 技术栈

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 28 |
| Frontend | React 18 + TypeScript + Tailwind CSS 3 |
| State | Zustand |
| Build | Vite 5 + electron-builder |
| LLM API | Multi-provider (Qianfan, VolcEngine, Alibaba Cloud, etc.) |

---

## Installation / 安装

### macOS (Apple Silicon / ARM64)

The app is distributed as a `.dmg` file. Since the app is not code-signed with an Apple Developer certificate, macOS Gatekeeper will block it by default. Follow these steps:

应用以 `.dmg` 文件分发。由于未使用 Apple 开发者证书签名，macOS 的 Gatekeeper 会默认阻止。请按以下步骤操作：

1. **Open the DMG file** — Double-click the `.dmg` to mount it. You'll see an `安装 Onit.command` file and an `Applications` folder.

   **打开 DMG 文件** — 双击 `.dmg` 挂载磁盘映像。你会看到 `安装 Onit.command` 文件和 `Applications` 文件夹。

2. **Right-click** the `安装 Onit.command` file and select **Open**. macOS will show a warning — click **Done** (完成).

   **右键点击** `安装 Onit.command` 文件，选择 **打开**。macOS 会弹出警告——点击 **完成**。

3. **Go to System Settings** → **Privacy & Security**. Scroll down to the **Security** section. You'll see a message about the blocked file. Click **"Open Anyway"** (仍要打开).

   **打开系统设置** → **隐私与安全性**。滑到最底下的 **安全性** 部分。你会看到关于被阻止文件的提示。点击 **"仍要打开"**。

4. **A confirmation dialog will appear** — Click **"Open Anyway"** (仍要打开) again. The installation script will run in Terminal.

   **会弹出确认对话框** — 再次点击 **"仍要打开"**。安装脚本将在终端中运行。

5. **If another Gatekeeper prompt appears** for the `.command` file itself, click **"Open Anyway"** (仍要打开) one more time. Installation is now complete!

   **如果再次出现 Gatekeeper 提示**，再点击一次 **"仍要打开"** 即可完成安装！

### Windows

Download the Windows installer and follow the standard installation wizard.

下载 Windows 安装程序，按照标准安装向导完成安装。

---

## Getting Started / 快速上手

### 1. Login / 登录

On first launch, you'll need to configure your AI provider. Onit supports two billing modes:

首次启动时需要配置 AI 服务商。Onit 支持两种计费模式：

- **Coding Plan** — Connect to mainstream coding plan providers (Qianfan, VolcEngine, Alibaba Cloud, etc.).
- **API Call** — Enter your API key and choose from multiple models (DeepSeek V3, ERNIE 4.5, etc.).

- **Coding Plan** — 接入主流 Coding Plan 服务商（百度千帆、火山方舟、阿里百炼等）。
- **API Call** — 输入 API Key，自由选择模型（DeepSeek V3、ERNIE 4.5 等）。

### 2. Start a Conversation / 开始对话

Type your request in natural language. For example:

用自然语言输入你的需求。例如：

- "Read the files in ~/Desktop/project and summarize the code structure"
- "Create a Python script that converts CSV to JSON"
- "Search for all TODO comments in this directory"

### 3. Set a Workspace / 设置工作区

Click the **Workspace** button in the input area to select a folder. The agent will have context about your project files and scope its operations within that directory.

点击输入区域的 **Workspace** 按钮选择文件夹。Agent 将了解你项目文件的上下文，并将操作范围限定在该目录内。

### 4. Choose Permission Mode / 选择权限模式

- **Plan Mode** 🛡️ — Agent asks before any file operation or command. Best for learning what the agent does.
- **AcceptEdit** ✅ — Smart defaults: safe operations run automatically, sensitive ones ask for permission. Recommended.
- **Full Access** ⚠️ — Everything runs automatically. Use only when you fully trust the task.

---

## Project Structure / 项目结构

```
electron/               # Electron main process
├── main.ts             # App lifecycle, IPC handlers
├── preload.ts          # Context bridge (main ↔ renderer)
└── agent/
    ├── index.ts        # Agent core — ReAct loop, LLM streaming
    ├── tools.ts        # Built-in tools (file ops, search, exec)
    ├── scheduler.ts    # Scheduled task manager
    └── types.ts        # Agent-side types

src/                    # React renderer
├── types/index.ts      # Shared type definitions
├── stores/
│   ├── sessionStore.ts # Session state management
│   └── settingsStore.ts# Settings & API config
├── components/
│   ├── Login.tsx       # API key entry
│   ├── Sidebar/        # Session list, scheduled tasks, search
│   ├── Chat/           # Message list, input, task status panel
│   └── Dialogs/        # Permission & scheduling dialogs
├── App.tsx             # Root component
└── index.css           # Tailwind + custom styles
```

---

## Development / 本地开发

```bash
# Install dependencies (use China mirror for Electron if needed)
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install

# Start dev server with hot reload
npm run dev

# Build for macOS (skip code signing for development)
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64
```

### Branches / 分支

| Branch | Description |
|--------|------------|
| `main` | v1.0.0 — macOS ARM64 release |
| `windows` | v1.0.0 — Windows platform adaptation |

---

## Data Storage / 数据存储

| Data | Location |
|------|----------|
| Sessions | `~/Library/Application Support/onit/onit-data/sessions/` (macOS) |
| Scheduled Tasks | `~/Library/Application Support/onit/onit-data/scheduled/` (macOS) |
| Settings | Browser localStorage (key: `onit-settings`) |

---

## Notes / 备注

- **Not code-signed** — The app is not signed with an Apple Developer certificate or Microsoft Authenticode. You'll need to bypass OS security prompts during installation (see instructions above).
- **LLM API required** — Onit requires an API key from a supported provider to function. It does not include a built-in model.
- **macOS ARM64 only** — The macOS build targets Apple Silicon (M1/M2/M3/M4). Intel Macs are not currently supported.
- **Scheduled tasks require the app to be running** — There is no background daemon; tasks only execute while Onit is open.

---

- **未签名** — 应用未使用 Apple 开发者证书或 Microsoft Authenticode 签名，安装时需要绕过系统安全提示（参见上方安装说明）。
- **需要 LLM API** — Onit 需要支持的服务商的 API Key 才能运行，不内置模型。
- **仅支持 macOS ARM64** — macOS 版本仅支持 Apple Silicon（M1/M2/M3/M4），暂不支持 Intel Mac。
- **定时任务需保持应用运行** — 没有后台守护进程，任务仅在 Onit 打开时执行。

---

## License / 许可

MIT
