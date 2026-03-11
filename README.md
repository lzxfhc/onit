# Onit - Desktop AI Agent

> Your reliable AI assistant, right on your desktop.
>
> 你的桌面 AI 助手，就在你身边。

[中文](#中文) | [English](#english)

---

<a id="中文"></a>

## 这是什么？

**Onit** 是一款原生桌面 AI Agent 应用，支持 macOS 和 Windows。不同于浏览器中的 AI 聊天工具，Onit 直接运行在你的电脑上，能够读写文件、编写代码、执行命令、搜索网页、管理任务——全部通过自然对话完成。

**核心理念：**

- **透明** — Agent 的每一步操作对你完全可见。它读了哪个文件、运行了什么命令，你一目了然。
- **可中断** — 你可以随时停止 Agent。控制权始终在你手中。
- **human in the loop** — 敏感操作需要你的许可。在执行重要变更前，Agent 会先征得你的同意。

## 功能特点

- **多会话支持** — 同时运行多个 Agent 会话，自由切换。
- **内置工具集** — 文件读写编辑删除、目录列表、内容搜索、命令执行、Web 搜索、网页抓取、任务管理。
- **Skills 系统** — 支持skills能力，在输入框中通过 `@` 快速调用。可扩展、可配置。
- **多平台 Coding Plan** — 支持主流厂商coding plan，支持api模型调用。
- **三种权限模式** — Plan 模式（确认所有操作）、AcceptEdit（智能确认）、Full Access（自动执行）。
- **定时任务** — 设置周期性自动执行的任务。
- **工作区感知** — 选择工作目录，让 Agent 专注于你的项目。
- **文件附件** — 直接附加文件到对话中供 Agent 分析。
- **后台执行** — 切换到其他会话时 Agent 继续工作，完成后通知你。

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Electron 28 |
| 前端 | React 18 + TypeScript + Tailwind CSS 3 |
| 状态管理 | Zustand |
| 构建 | Vite 5 + electron-builder |
| LLM API | 千帆 (Baidu) / 火山引擎 / 灵积 |

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

## 项目结构

```
electron/               # Electron 主进程
├── main.ts             # 应用生命周期、IPC 处理
├── preload.ts          # 上下文桥接 (主进程 ↔ 渲染进程)
└── agent/
    ├── index.ts        # Agent 核心 — ReAct 循环、LLM 流式调用
    ├── tools.ts        # 内置工具 (文件操作、搜索、执行、Web)
    ├── skills.ts       # Skills 加载与管理
    ├── scheduler.ts    # 定时任务管理
    └── types.ts        # Agent 侧类型定义

src/                    # React 渲染进程
├── types/index.ts      # 共享类型定义
├── stores/
│   ├── sessionStore.ts # 会话状态管理
│   └── settingsStore.ts# 设置与 API 配置
├── components/
│   ├── Login.tsx       # API Key 登录
│   ├── TopBar.tsx      # 顶部栏 (会话名称 & 面板开关)
│   ├── Sidebar/        # 会话列表、定时任务、搜索
│   ├── Chat/           # 消息列表、输入框、任务状态面板
│   └── Dialogs/        # 权限确认 & 定时任务对话框
├── utils/
│   └── platform.ts     # 跨平台工具
├── App.tsx             # 根组件
└── index.css           # Tailwind + 自定义样式
```

## 本地开发

```bash
# 安装依赖 (国内网络需设置 Electron 镜像)
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install

# 启动开发服务器 (热更新)
npm run dev

# 构建 macOS ARM64
npm run build:mac

# 构建 Windows x64
npm run build:win
```

### 分支

| 分支 | 说明 |
|------|------|
| `main` | macOS 最新版本 (v1.2.0) |
| `windows` | Windows 最新版本 (v1.2.0) |

## 数据存储

| 数据 | macOS | Windows |
|------|-------|---------|
| 会话 | `~/Library/Application Support/onit/onit-data/sessions/` | `%APPDATA%\onit\onit-data\sessions\` |
| 定时任务 | `~/Library/Application Support/onit/onit-data/scheduled/` | `%APPDATA%\onit\onit-data\scheduled\` |
| Skills | `~/Library/Application Support/onit/onit-data/skills/` | `%APPDATA%\onit\onit-data\skills\` |
| 设置 | 浏览器 localStorage (key: `onit-settings`) | 浏览器 localStorage (key: `onit-settings`) |

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
- **Multi-provider Coding Plan** — Supports list companies‘ coding plan providers with independent model parameters.
- **Three permission modes** — Plan Mode (confirm everything), AcceptEdit (smart confirmations), Full Access (auto-execute).
- **Scheduled tasks** — Set up recurring tasks with cron-like scheduling.
- **Workspace awareness** — Select a working directory for the agent to focus on your project.
- **File attachment** — Attach files directly to your conversation for the agent to analyze.
- **Background execution** — Switch to another session while the agent works, get notified when it's done.

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

## License

MIT
