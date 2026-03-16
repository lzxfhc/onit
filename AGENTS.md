# Onit - Desktop AI Agent for macOS

## Project Overview
Onit is an Electron-based desktop AI agent application targeting macOS ARM64. It provides a visual interface for non-technical users to leverage code agent capabilities for daily tasks. The core philosophy is "a reliable assistant sitting beside you" — transparent, interruptible, and human-in-the-loop.

## Tech Stack
- **Runtime**: Electron 28 (main process) + Chromium (renderer)
- **Frontend**: React 18 + TypeScript + Tailwind CSS 3
- **Build**: Vite 5 + vite-plugin-electron
- **State**: Zustand (lightweight, no boilerplate)
- **Packaging**: electron-builder → `.dmg` for macOS ARM64
- **Icons**: lucide-react
- **Markdown**: react-markdown + remark-gfm

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Electron Main Process           │
│  ┌───────────┐  ┌──────────────┐  ┌───────────┐ │
│  │   main.ts │  │ AgentManager │  │ Scheduler  │ │
│  │  (window, │  │  (agent loop,│  │ Manager    │ │
│  │   IPC)    │  │   LLM calls, │  │ (cron jobs)│ │
│  │           │  │   tools)     │  │            │ │
│  └─────┬─────┘  └──────┬───────┘  └─────┬──────┘ │
│        │               │                │        │
│        └───────────────┼────────────────┘        │
│                  IPC Bridge                       │
│              (preload.ts / contextBridge)         │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────┐
│               Electron Renderer Process          │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │
│  │ Zustand   │  │ Components │  │  Types       │ │
│  │ Stores    │  │ (React)    │  │  (shared)    │ │
│  │ - session │  │ - Login    │  │              │ │
│  │ - settings│  │ - Sidebar  │  │              │ │
│  │           │  │ - Chat     │  │              │ │
│  │           │  │ - Dialogs  │  │              │ │
│  └──────────┘  └────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────┘
```

## File Structure

### Electron Main Process (`electron/`)
| File | Purpose |
|------|---------|
| `main.ts` | App lifecycle, window creation, IPC handler registration, data directory management |
| `preload.ts` | Context bridge — exposes `window.electronAPI` to renderer. ALL main↔renderer communication goes through here |
| `agent/index.ts` | **Core**: `AgentManager` class — manages agent sessions, ReAct loop, streaming LLM calls, permission checking |
| `agent/tools.ts` | 9 built-in tools (read/write/edit/delete files, list dir, search files/content, exec command, task list). Also exports `getToolRiskLevel()` |
| `agent/scheduler.ts` | `SchedulerManager` — cron-based scheduled tasks using `node-schedule`, persisted as JSON files |
| `agent/types.ts` | Agent-side type definitions (tool defs, messages, risk levels) |

### React Renderer (`src/`)
| File | Purpose |
|------|---------|
| `types/index.ts` | **Shared types** — Session, Message, ToolCall, PermissionRequest, AppSettings, available models list, defaults |
| `stores/sessionStore.ts` | Zustand store for sessions — CRUD, message management, background task state, workspace/permission/model per session |
| `stores/settingsStore.ts` | Zustand store for app settings — API config, login state, scheduled tasks, permission request queue |
| `components/Login.tsx` | API key entry — supports Coding Plan and API Call billing modes |
| `components/Sidebar/index.tsx` | Sidebar container with 3 tabs: Sessions, Scheduled, Search |
| `components/Sidebar/SessionList.tsx` | Session list with context menu (delete), time display, status indicators |
| `components/Sidebar/ActiveTasks.tsx` | Background running / unviewed completed tasks section |
| `components/Sidebar/ScheduledTasks.tsx` | Scheduled task CRUD UI |
| `components/Sidebar/HistorySearch.tsx` | Full-text search across all session messages |
| `components/Chat/index.tsx` | **Core**: Chat orchestrator — sets up IPC listeners, manages send/stop, coordinates streaming updates |
| `components/Chat/MessageList.tsx` | Message rendering with auto-scroll, empty state with suggestions |
| `components/Chat/MessageBubble.tsx` | Individual message — markdown rendering, thinking blocks (collapsible), tool call blocks (expandable with input/output) |
| `components/Chat/InputBox.tsx` | Input area — workspace picker, file attach, model switcher, permission mode selector, active tasks bar |
| `components/Chat/TaskStatus.tsx` | Right panel — 3 tabs: Tasks (todo list), Tools (all tool calls), Files (workspace files) |
| `components/Dialogs/PermissionDialog.tsx` | Modal for permission requests — Allow/Deny/Always Allow |
| `components/Dialogs/ScheduledTaskDialog.tsx` | Create/edit scheduled task form |

## Key Design Patterns

### Agent Loop (electron/agent/index.ts)
1. User sends message → renderer calls `window.electronAPI.startAgent()`
2. Main process `AgentManager.startAgent()` builds conversation history + system prompt
3. `runAgentLoop()` iterates up to 30 times:
   - Call LLM via streaming HTTPS (SSE format)
   - Stream `content` and `reasoning_content` chunks back to renderer via IPC
   - If tool calls returned: check permission FIRST (`getToolRiskLevel` + `requestPermission`), THEN execute
   - Feed tool results back into conversation, continue loop
4. Loop ends when: no more tool calls, max iterations, user stops, or error

### Permission System
Three modes, checked in `requestPermission()`:
- **Plan**: Ask for ALL non-safe operations
- **AcceptEdit**: Ask, but support "Always Allow" per tool type (stored in `alwaysAllowedTools` Set)
- **Full Access**: Auto-approve everything, only warn on `dangerous` level

Risk levels from `getToolRiskLevel()`:
- `safe`: read_file, list_directory, search_files, search_content, create_task_list
- `moderate`: write_file (new file), edit_file, most shell commands
- `dangerous`: delete_file, rm -rf, chmod -R, etc.

**CRITICAL**: Permission check MUST happen BEFORE tool execution for moderate/dangerous operations.

### Background Tasks
- When user switches sessions while agent is running → current session marked `isBackgroundRunning: true`
- On completion → `backgroundCompleted: true`, `hasUnviewedResult: true`
- Displayed in: Sidebar ActiveTasks section + InputBox ActiveTasksBar
- Viewing clears the unviewed state

### IPC Communication
All main↔renderer communication uses Electron IPC through `preload.ts`:
- **Invoke (renderer→main, async response)**: `agent:start`, `agent:stop`, `sessions:save/load/delete`, `scheduler:*`, `dialog:*`
- **Send (main→renderer, event push)**: `agent:stream`, `agent:complete`, `agent:error`, `agent:permission-request`, `agent:task-update`, `agent:tool-call`, `agent:workspace-files`
- **Send (renderer→main, fire-and-forget)**: `agent:permission-response`

### State Management
- `sessionStore`: Session CRUD, message operations, tool call updates. Uses `useSessionStore.getState()` in IPC callbacks to avoid stale closures.
- `settingsStore`: API config persisted to `localStorage` (key: `onit-settings`). Scheduled tasks persisted via main process to disk.

## API Integration (Qianfan)

### Coding Plan Mode
- URL: `https://qianfan.baidubce.com/v2/coding/chat/completions`
- Model: always `qianfan-code-latest` (maps to glm-5 on backend)
- Auth: `Authorization: Bearer <api-key>`
- Supports: streaming (SSE), tool_calls, reasoning_content

### API Call Mode
- URL: `https://qianfan.baidubce.com/v2/chat/completions`
- Model: user-selected (ernie-4.5-8k, deepseek-v3, etc.)
- Same auth format

### Streaming Response Format
```
data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}
data: {"choices":[{"delta":{"content":"response text"}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","function":{"name":"read_file","arguments":"{..."}}]}}]}
data: [DONE]
```
Note: `tool_calls` arguments stream incrementally — accumulate by index.

## Known Issues & Gotchas

### Must-Know for Development
1. **Electron binary download**: `npm install` downloads Electron binary (~180MB). In China, set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` to avoid timeout
2. **electron-builder**: Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip code signing during development. Production needs Apple Developer certificate.
3. **Stale closures in IPC listeners**: The `useEffect([], [])` in `Chat/index.tsx` sets up IPC listeners once. Inside callbacks, use `useSessionStore.getState()` instead of closed-over `sessions` variable
4. **Permission before execution**: In `agent/index.ts`, risk level is checked via `getToolRiskLevel()` BEFORE `executeTool()` is called. Never reverse this order.
5. **Tool call argument streaming**: LLM streams tool call arguments in chunks. They must be concatenated by `tc.index`. The `id` field only appears in the first chunk.
6. **node-schedule in main process**: Scheduled tasks only run while the app is open. No background daemon.

### CSS/Tailwind Notes
- Custom colors defined in `tailwind.config.js`: `canvas`, `surface`, `charcoal`, `accent`, `terminal`, etc.
- Custom classes in `src/index.css`: `.btn-primary`, `.card`, `.input`, `.sidebar-item`, `.status-running`, etc.
- Border radius default is 8px (`rounded`), sm is 6px (`rounded-sm`)
- All transitions should use `duration-200` (0.2s)
- Markdown content styled via `.markdown-content` class in index.css

### Build & Distribution
- `npm run dev` — Vite dev server + Electron with hot reload
- `npx vite build` — Build frontend + electron (outputs to `dist/` and `dist-electron/`)
- `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64` — Build `.dmg`
- `electronDist` in package.json points to local `node_modules/electron/dist` to avoid re-download during packaging
- Output: `dist/Onit-{version}-arm64.dmg` and `dist/mac-arm64/Onit.app`

## Data Storage
- **Sessions**: `~/Library/Application Support/onit/onit-data/sessions/{id}.json`
- **Scheduled Tasks**: `~/Library/Application Support/onit/onit-data/scheduled/{id}.json`
- **Settings**: Renderer `localStorage` key `onit-settings`

## Design Language
Minimal tech aesthetic + warm UX:
- Canvas: `#FAFAFA` (light gray), Surface: `#FFFFFF` (white cards)
- Text: `#1A1A2E` (charcoal), Secondary: `#6B7280`, Tertiary: `#9CA3AF`
- Accent: `#3B82F6` (blue), rounded corners 6-8px, transitions 0.2s
- Code blocks: dark terminal style (`#1E1E2E`)
- macOS native title bar (`titleBarStyle: 'hiddenInset'`, traffic lights at x:16 y:16)

## Future Development Notes
- Skills marketplace (`skills广场`) is in the requirements but not yet implemented
- VM sandbox for file operations is deferred (requirements say "可以不使用VM先")
- App icon is using Electron default — needs custom icon design
- Code signing needed for production distribution
- Auto-update mechanism not yet implemented
- The `react-syntax-highlighter` package is installed but not yet used for code block highlighting in markdown
