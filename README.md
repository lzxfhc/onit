# Onit - Desktop AI Agent

> Your reliable AI assistant, right on your desktop.
>
> 你的桌面 AI 助手，就在你身边。

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## What is Onit?

**Onit** is a native desktop AI agent application for macOS and Windows. Unlike browser-based AI chat tools, Onit runs directly on your computer, capable of reading files, writing code, executing commands, searching the web, and managing tasks — all through natural conversation.

**Core Philosophy:**

- **Transparent** — Every action the agent takes is visible to you. You see every file it reads, every command it runs.
- **Interruptible** — You can stop the agent at any time. You're always in control.
- **Human-in-the-loop** — Sensitive operations require your permission. The agent asks before making important changes.

## Features

- **Multi-session support** — Run multiple agent sessions simultaneously, switch freely between them.
- **Built-in tools** — File read/write/edit/delete, directory listing, content search, command execution, web search, URL fetching, task management.
- **Skills system** — Custom prompt templates invoked via `@` mention in the input box. Extensible and configurable.
- **Multi-provider Coding Plan** — Supports Qianfan, Volcengine, and Dashscope providers with independent model parameters.
- **Three permission modes** — Plan Mode (confirm everything), AcceptEdit (smart confirmations), Full Access (auto-execute).
- **Scheduled tasks** — Set up recurring tasks with cron-like scheduling.
- **Workspace awareness** — Select a working directory for the agent to focus on your project.
- **File attachment** — Attach files directly to your conversation for the agent to analyze.
- **Streaming responses** — See the agent's thinking and actions in real-time.
- **Background execution** — Switch to another session while the agent works, get notified when it's done.
- **History search** — Full-text search across all your past conversations.
- **TopBar & side panel** — Session name display, collapsible right panel with Tasks / Tools / Files tabs.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 28 |
| Frontend | React 18 + TypeScript + Tailwind CSS 3 |
| State | Zustand |
| Build | Vite 5 + electron-builder |
| LLM API | Qianfan (Baidu) / Volcengine / Dashscope |

## Installation

### macOS (Apple Silicon / ARM64)

The app is distributed as a `.dmg` file. Since the app is not code-signed with an Apple Developer certificate, macOS Gatekeeper will block it by default. Follow these steps:

1. **Open the DMG file** — Double-click the `.dmg` to mount it. You'll see an `安装 Onit.command` file and an `Applications` folder.
2. **Right-click** the `安装 Onit.command` file and select **Open**. macOS will show a warning — click **Done**.
3. **Go to System Settings** → **Privacy & Security**. Scroll down to the **Security** section. You'll see a message about the blocked file. Click **"Open Anyway"**.
4. **A confirmation dialog will appear** — Click **"Open Anyway"** again. The installation script will run in Terminal.
5. **If another Gatekeeper prompt appears** for the `.command` file itself, click **"Open Anyway"** one more time. Installation is now complete!

### Windows (x64)

1. Download and extract the Windows build package.
2. Run `install-onit.bat` — The script will install Onit to `%LOCALAPPDATA%\Onit`, create desktop and Start Menu shortcuts, and launch the app automatically.

## Getting Started

### 1. Login

On first launch, you'll need to enter your API key. Onit supports two billing modes:

- **Coding Plan** — Optimized for coding tasks. Supports Qianfan, Volcengine, and Dashscope providers.
- **API Call** — Choose from multiple models (ERNIE 4.5, DeepSeek V3, etc.).

### 2. Start a Conversation

Type your request in natural language. For example:

- "Read the files in ~/Desktop/project and summarize the code structure"
- "Create a Python script that converts CSV to JSON"
- "Search for all TODO comments in this directory"

### 3. Use Skills

Type `@` in the input box to invoke a skill. Skills are customizable prompt templates for common tasks.

### 4. Set a Workspace

Click the **Workspace** button in the input area to select a folder. The agent will have context about your project files.

### 5. Choose Permission Mode

- **Plan Mode** — Agent asks before any file operation or command. Best for learning what the agent does.
- **AcceptEdit** — Smart defaults: safe operations run automatically, sensitive ones ask for permission. Recommended.
- **Full Access** — Everything runs automatically. Use only when you fully trust the task.

## Project Structure

```
electron/               # Electron main process
├── main.ts             # App lifecycle, IPC handlers
├── preload.ts          # Context bridge (main ↔ renderer)
└── agent/
    ├── index.ts        # Agent core — ReAct loop, LLM streaming
    ├── tools.ts        # Built-in tools (file ops, search, exec, web)
    ├── skills.ts       # Skills loader and manager
    ├── scheduler.ts    # Scheduled task manager
    └── types.ts        # Agent-side types

src/                    # React renderer
├── types/index.ts      # Shared type definitions
├── stores/
│   ├── sessionStore.ts # Session state management
│   └── settingsStore.ts# Settings & API config
├── components/
│   ├── Login.tsx       # API key entry
│   ├── TopBar.tsx      # Top bar with session name & panel toggle
│   ├── Sidebar/        # Session list, scheduled tasks, search
│   ├── Chat/           # Message list, input, task status panel
│   └── Dialogs/        # Permission & scheduling dialogs
├── utils/
│   └── platform.ts     # Cross-platform utilities
├── App.tsx             # Root component
└── index.css           # Tailwind + custom styles
```

## Development

```bash
# Install dependencies (use China mirror for Electron if needed)
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install

# Start dev server with hot reload
npm run dev

# Build for macOS ARM64
npm run build:mac

# Build for Windows x64
npm run build:win
```

### Branches

| Branch | Description |
|--------|------------|
| `main` | Latest macOS release (v1.2.0) |
| `windows` | Latest Windows release (v1.2.0) |

## Data Storage

| Data | macOS | Windows |
|------|-------|---------|
| Sessions | `~/Library/Application Support/onit/onit-data/sessions/` | `%APPDATA%\onit\onit-data\sessions\` |
| Scheduled Tasks | `~/Library/Application Support/onit/onit-data/scheduled/` | `%APPDATA%\onit\onit-data\scheduled\` |
| Skills | `~/Library/Application Support/onit/onit-data/skills/` | `%APPDATA%\onit\onit-data\skills\` |
| Settings | Browser localStorage (key: `onit-settings`) | Browser localStorage (key: `onit-settings`) |

## Version History

| Version | Date | Highlights |
|---------|------|-----------|
| v1.2.0 | 2025-03 | Multi-provider Coding Plan, TopBar, right panel, search tool fixes |
| v1.1.0 | 2025-02 | Skills system, web tools (search + fetch), scheduled task enhancements |
| v1.0.0 | 2025-01 | Initial release — agent loop, file tools, permission system, multi-session |

## Notes

- **Not code-signed** — The app is not signed with an Apple Developer certificate or Microsoft Authenticode. You'll need to bypass OS security prompts during installation.
- **LLM API required** — Onit requires an API key (Qianfan / Volcengine / Dashscope) to function. It does not include a built-in model.
- **macOS ARM64 only** — The macOS build targets Apple Silicon (M1/M2/M3/M4). Intel Macs are not currently supported.
- **Windows x64** — The Windows build targets 64-bit x86 systems.
- **Scheduled tasks require the app to be running** — There is no background daemon; tasks only execute while Onit is open.

---

<a id="中文"></a>

## 这是什么？

**Onit** 是一款原生桌面 AI Agent 应用，支持 macOS 和 Windows。不同于浏览器中的 AI 聊天工具，Onit 直接运行在你的电脑上，能够读写文件、编写代码、执行命令、搜索网页、管理任务——全部通过自然对话完成。

**核心理念：**

- **透明** — Agent 的每一步操作对你完全可见。它读了哪个文件、运行了什么命令，你一目了然。
- **可中断** — 你可以随时停止 Agent。控制权始终在你手中。
- **人在回路** — 敏感操作需要你的许可。在执行重要变更前，Agent 会先征得你的同意。

## 功能特点

- **多会话支持** — 同时运行多个 Agent 会话，自由切换。
- **内置工具集** — 文件读写编辑删除、目录列表、内容搜索、命令执行、Web 搜索、网页抓取、任务管理。
- **Skills 系统** — 自定义提示词模板，在输入框中通过 `@` 快速调用。可扩展、可配置。
- **多平台 Coding Plan** — 支持千帆、火山引擎、灵积三个 Provider，各自独立模型参数。
- **三种权限模式** — Plan 模式（确认所有操作）、AcceptEdit（智能确认）、Full Access（自动执行）。
- **定时任务** — 设置周期性自动执行的任务。
- **工作区感知** — 选择工作目录，让 Agent 专注于你的项目。
- **文件附件** — 直接附加文件到对话中供 Agent 分析。
- **流式响应** — 实时查看 Agent 的思考过程和操作动态。
- **后台执行** — 切换到其他会话时 Agent 继续工作，完成后通知你。
- **历史搜索** — 跨所有历史对话的全文搜索。
- **顶栏与侧边面板** — 显示会话名称，可折叠右侧面板含任务 / 工具 / 文件三个 Tab。

## 安装

### macOS (Apple Silicon / ARM64)

应用以 `.dmg` 文件分发。由于未使用 Apple 开发者证书签名，macOS 的 Gatekeeper 会默认阻止。请按以下步骤操作：

1. **打开 DMG 文件** — 双击 `.dmg` 挂载磁盘映像。你会看到 `安装 Onit.command` 文件和 `Applications` 文件夹。
2. **右键点击** `安装 Onit.command` 文件，选择 **打开**。macOS 会弹出警告——点击 **完成**。
3. **打开系统设置** → **隐私与安全性**。滑到最底下的 **安全性** 部分。你会看到关于被阻止文件的提示。点击 **"仍要打开"**。
4. **会弹出确认对话框** — 再次点击 **"仍要打开"**。安装脚本将在终端中运行。
5. **如果再次出现 Gatekeeper 提示**，再点击一次 **"仍要打开"** 即可完成安装！

### Windows (x64)

1. 下载并解压 Windows 构建包。
2. 运行 `install-onit.bat` — 脚本会将 Onit 安装到 `%LOCALAPPDATA%\Onit`，创建桌面和开始菜单快捷方式，并自动启动应用。

## 快速上手

### 1. 登录

首次启动时需要输入 API Key。Onit 支持两种计费模式：

- **Coding Plan** — 为编码任务优化。支持千帆、火山引擎、灵积三个 Provider。
- **API Call** — 可选择多种模型（ERNIE 4.5、DeepSeek V3 等）。

### 2. 开始对话

用自然语言输入你的需求。例如：

- "读取 ~/Desktop/project 的文件并总结代码结构"
- "创建一个将 CSV 转换为 JSON 的 Python 脚本"
- "搜索这个目录中所有的 TODO 注释"

### 3. 使用 Skills

在输入框中输入 `@` 调用 Skill。Skills 是可自定义的提示词模板，用于常见任务场景。

### 4. 设置工作区

点击输入区域的 **Workspace** 按钮选择文件夹。Agent 将了解你项目文件的上下文。

### 5. 选择权限模式

- **Plan 模式** — Agent 在执行任何文件操作或命令前都会征求确认。适合了解 Agent 的工作方式。
- **AcceptEdit** — 智能默认：安全操作自动执行，敏感操作询问许可。推荐使用。
- **Full Access** — 所有操作自动执行。仅在完全信任任务时使用。

## 版本历史

| 版本 | 日期 | 主要更新 |
|------|------|---------|
| v1.2.0 | 2025-03 | 多平台 Coding Plan、顶部程序栏、右侧面板、搜索工具修复 |
| v1.1.0 | 2025-02 | Skills 系统、Web 工具（搜索 + 抓取）、定时任务增强 |
| v1.0.0 | 2025-01 | 首个版本 — Agent 循环、文件工具、权限系统、多会话 |

## 备注

- **未签名** — 应用未使用 Apple 开发者证书或 Microsoft Authenticode 签名。安装时需要绕过系统安全提示（参见上方安装说明）。
- **需要 LLM API** — Onit 需要 API Key（千帆 / 火山引擎 / 灵积）才能运行，不内置模型。
- **macOS 仅支持 ARM64** — macOS 版本仅支持 Apple Silicon（M1/M2/M3/M4），暂不支持 Intel Mac。
- **Windows x64** — Windows 版本支持 64 位 x86 系统。
- **定时任务需保持应用运行** — 没有后台守护进程，任务仅在 Onit 打开时执行。

---

## License

MIT
