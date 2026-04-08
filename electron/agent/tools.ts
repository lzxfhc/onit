import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import { AgentToolDef, ToolExecutionResult, RiskLevel } from './types'

// WebFetch URL cache (15-minute TTL, max 50 entries)
const WEB_FETCH_CACHE_TTL_MS = 15 * 60 * 1000
const WEB_FETCH_CACHE_MAX_ENTRIES = 50
const webFetchCache = new Map<string, { text: string; timestamp: number }>()
import { isExtractableFile, extractFileContent } from '../utils/file-extract'
import { fileReadCache } from '../utils/file-cache'

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path. Use this to examine files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to read' },
          start_line: { type: 'number', description: 'Optional 1-based start line (inclusive)' },
          end_line: { type: 'number', description: 'Optional 1-based end line (inclusive)' },
          max_length: { type: 'number', description: 'Optional maximum characters to return (default 20000)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it does not exist, or overwrites if it does.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to write' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by replacing a specific string with a new string. The old_string MUST be unique in the file — if it appears multiple times, the edit will fail. Include enough surrounding context to make old_string unambiguous. You MUST read_file before editing. Use replace_all=true only for renaming variables across the entire file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to edit' },
          old_string: { type: 'string', description: 'The exact string to find and replace (must be unique in the file unless replace_all=true)' },
          new_string: { type: 'string', description: 'The string to replace it with' },
          replace_all: { type: 'boolean', description: 'Replace ALL occurrences instead of requiring uniqueness (default: false). Use for variable renames.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or empty directory at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file or directory to delete' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the contents of a directory, showing files and subdirectories. Use depth > 1 to see the tree structure without multiple calls.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory to list' },
          depth: { type: 'number', description: 'How many levels deep to list (default 1, max 4). Use 2-3 to see project structure quickly.' },
          include_hidden: { type: 'boolean', description: 'Include dotfiles like .gitignore, .env.example (default false)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for files matching a pattern in a directory tree.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Root directory to search from' },
          pattern: { type: 'string', description: 'Glob pattern to match files (e.g., "*.ts", "**/*.json")' },
          max_results: { type: 'number', description: 'Optional maximum number of results to return (default 200)' },
          max_depth: { type: 'number', description: 'Optional maximum directory depth to traverse (default 20)' },
          timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 20000; in-workspace 90000)' },
          max_entries: { type: 'number', description: 'Optional maximum directory entries to visit (default 120000; in-workspace 400000)' },
        },
        required: ['directory', 'pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_content',
      description: 'Search for a text pattern within files in a directory.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Root directory to search from' },
          query: { type: 'string', description: 'Text or regex pattern to search for' },
          file_pattern: { type: 'string', description: 'Optional file glob pattern to limit search (e.g., "*.ts")' },
          max_results: { type: 'number', description: 'Optional maximum number of files to report matches from (default 120)' },
          max_depth: { type: 'number', description: 'Optional maximum directory depth to traverse (default 16)' },
          timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 30000; in-workspace 150000)' },
          max_entries: { type: 'number', description: 'Optional maximum directory entries to visit (default 80000; in-workspace 240000)' },
          max_files: { type: 'number', description: 'Optional maximum number of files to scan (default 3000; in-workspace 20000)' },
          max_read_bytes: { type: 'number', description: 'Optional maximum bytes to read per file (default 1048576; in-workspace 4194304; max 16777216)' },
        },
        required: ['directory', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute a shell command and return its output. Use for running scripts, installing packages, git operations, etc. Default timeout is 60 seconds — increase timeout_ms for long-running commands like npm install, builds, or test suites.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          working_directory: { type: 'string', description: 'Working directory for the command (optional)' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 60000, max 600000). Increase for long commands like npm install or test suites.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task_list',
      description: 'Create or update a task list for the current operation. Use this to break down complex tasks.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in-progress', 'completed'] },
              },
              required: ['id', 'title', 'status'],
            },
            description: 'Array of task items',
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information. Returns search results with titles, snippets, and URLs. Use this to find current information, documentation, news, or any web content.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          max_results: { type: 'number', description: 'Maximum number of results to return (default 5, max 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the content of a web page and return it as readable text. Use this to read documentation, articles, blog posts, or any web content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          max_length: { type: 'number', description: 'Maximum characters to return (default 20000)' },
        },
        required: ['url'],
      },
    },
  },
  // --- Browser tools ---
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Open a URL in the browser. Returns the page title and a list of interactive elements (buttons, links, inputs, etc.). Use this for pages that need JavaScript rendering or user interaction. For simple text content, prefer web_fetch.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to navigate to (must start with http:// or https://)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_action',
      description: 'Perform an action on the current browser page. You can click buttons, type in inputs, select options, scroll, press keys, or wait. Specify the target element by natural language description (e.g., "login button", "search box") or CSS selector.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'type', 'select', 'scroll', 'hover', 'press_key', 'wait'], description: 'The action to perform' },
          element: { type: 'string', description: 'Natural language description of the element (e.g., "登录按钮", "search input"). Can also use element index like "[3]".' },
          selector: { type: 'string', description: 'CSS selector for precise element targeting. Takes priority over "element".' },
          value: { type: 'string', description: 'Value for type (text to enter), select (option), press_key (key name like "Enter"), scroll ("up"/"down"), or wait (milliseconds).' },
          description: { type: 'string', description: 'Human-readable description of what this action does (shown in permission dialog)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_extract',
      description: 'Extract content from the current browser page. Supports: "text" (clean text), "html" (raw HTML), "selector" (text from CSS selector matches), "structured" (tables and lists).',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['text', 'html', 'selector', 'structured'], description: 'Extraction mode (default: text)' },
          selector: { type: 'string', description: 'CSS selector (required for "selector" mode)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current browser page. Returns the file path to the saved PNG image.',
      parameters: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of just the viewport (default: false)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Close the browser and release resources. Call this when you are done with browser operations.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  // --- Notebook tool ---
  {
    type: 'function',
    function: {
      name: 'notebook_edit',
      description: 'Edit a Jupyter notebook (.ipynb) file by cell index. Can insert, replace, or delete cells. Use read_file first to see the notebook structure. Each cell has a type (code/markdown) and source content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the .ipynb file' },
          action: { type: 'string', enum: ['insert', 'replace', 'delete'], description: 'What to do: insert a new cell, replace an existing cell, or delete a cell' },
          cell_index: { type: 'number', description: 'Cell index (0-based). For insert: index to insert BEFORE (use -1 to append). For replace/delete: the target cell.' },
          cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type (required for insert and replace)' },
          source: { type: 'string', description: 'Cell content (required for insert and replace)' },
        },
        required: ['path', 'action', 'cell_index'],
      },
    },
  },
  // --- Git worktree tools ---
  {
    type: 'function',
    function: {
      name: 'worktree_create',
      description: 'Create a git worktree for isolated parallel development. Creates a new working directory on a separate branch without affecting the main working tree. Useful when you need to work on multiple branches simultaneously or want to isolate changes.',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Branch name for the worktree. Created from HEAD if it does not exist.' },
          path: { type: 'string', description: 'Path where the worktree will be created (optional — defaults to ../repo-branch)' },
        },
        required: ['branch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worktree_remove',
      description: 'Remove a git worktree and clean up its directory. Use when you are done with isolated work.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the worktree to remove' },
        },
        required: ['path'],
      },
    },
  },
  // --- Code intelligence tool ---
  {
    type: 'function',
    function: {
      name: 'find_symbol',
      description: 'Find where a symbol (function, class, variable, type) is defined or referenced in the codebase. More precise than text search — understands code structure. Works best for TypeScript/JavaScript projects. For other languages, falls back to pattern-based search.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'The symbol name to find (e.g., "validateToken", "UserProfile", "handleSubmit")' },
          directory: { type: 'string', description: 'Root directory to search in' },
          mode: { type: 'string', enum: ['definition', 'references', 'all'], description: 'What to find: "definition" (where defined), "references" (where used), "all" (both). Default: "all"' },
        },
        required: ['symbol', 'directory'],
      },
    },
  },
  // --- Tool search (deferred loading) ---
  {
    type: 'function',
    function: {
      name: 'tool_search',
      description: 'Search for and load additional tools that are not in the default tool set. Some specialized tools (browser automation, notebook editing, git worktree, interactive questions, plan mode) are deferred — call this tool to load their schemas before using them. Use "select:tool_name" for exact matches or keywords for search.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query. Use "select:browser_navigate,browser_action" for exact selection, or keywords like "browser" or "notebook jupyter"' },
        },
        required: ['query'],
      },
    },
  },
  // --- Interactive tools ---
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user one or more structured questions with selectable options. Use this to gather preferences, clarify requirements, get decisions on implementation choices, or offer direction options. Users can always provide custom text via an "Other" option that is automatically added. If you recommend a specific option, make it the first in the list and add "(Recommended)" to its label.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The complete question to ask' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Short display text (1-8 words)' },
                      description: { type: 'string', description: 'Explanation of what this option means' },
                    },
                    required: ['label'],
                  },
                  description: 'Available options (2-4). An "Other" free-text option is always added automatically.',
                },
                multiSelect: { type: 'boolean', description: 'Allow multiple selections (default: false)' },
              },
              required: ['question', 'options'],
            },
            description: 'Array of questions to ask (1-4 questions)',
          },
        },
        required: ['questions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enter_plan_mode',
      description: `Request to enter plan mode. Use this proactively before starting non-trivial work. In plan mode you explore with read-only tools, clarify with ask_user, then present a plan via exit_plan_mode for user approval.

## Decision Framework

Ask yourself three questions. If ANY answer points to "plan", enter plan mode:

**1. Confidence — Do I know exactly what to do?**
- High confidence → just do it. ("Fix the typo in line 42" — obvious what to do.)
- Low confidence → plan first. ("Make the app faster" — need to investigate before acting.)
- Rule of thumb: if you would need to explore or research before your first action, plan.

**2. Reversibility — If I do it wrong, is it easy to undo?**
- Easy to undo → try and iterate. ("Add a console.log" — trivial to revert.)
- Hard to undo → plan first. ("Migrate the database" / "批量重命名500个文件" — mistakes are costly.)
- Rule of thumb: if the user would lose work, time, or data from a wrong approach, plan.

**3. Alignment — Does the user need to make a choice here?**
- No choice needed → just do it. ("Run the tests" — only one way.)
- Simple choice → use ask_user instead. ("用中文还是英文写？" — quick question, no exploration needed.)
- Complex choice requiring exploration → plan. ("重构认证系统" — need to explore the codebase to even know what the options are.)

## ask_user vs enter_plan_mode

- **ask_user**: You already understand the task but need the user to pick between a few options. Lightweight, one question, no exploration needed.
- **enter_plan_mode**: You need to explore, research, or think before you can even formulate the options. Heavy, involves investigation before presenting a plan.

## Examples

Plan first:
- "帮我做个竞品分析然后出报告" — low confidence (what dimensions?), needs user alignment (what format?)
- "Add user authentication to the app" — low confidence (what approach?), hard to undo (touches many files)
- "整理我桌面上的文件" — needs alignment (by date? by type?), somewhat hard to undo
- "帮我把这个项目部署上线" — hard to undo, multi-step with dependencies

Just do it:
- "这个文件什么内容？" — high confidence, trivially reversible
- "Fix the typo in README" — high confidence, trivially reversible
- "Run the tests" — high confidence, no choice needed
- "帮我搜一下天气" — single step, no alignment needed
- "把第42行的 foo 改成 bar" — explicit instruction, no ambiguity

If unsure, err on the side of planning.`,
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Brief explanation of why planning is needed (1-2 sentences)' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exit_plan_mode',
      description: 'Signal that your plan is complete and ready for user review. Call this ONLY when in plan mode. The user will see your plan and can approve (exits plan mode, you start executing) or reject with feedback (you stay in plan mode to refine). Your last assistant message before calling this should contain the full plan.',
      parameters: {
        type: 'object',
        properties: {
          planSummary: { type: 'string', description: 'Brief summary of the plan (1-3 sentences)' },
          keyActions: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of key actions in the plan (files to modify, URLs to visit, commands to run, etc.)',
          },
        },
        required: ['planSummary'],
      },
    },
  },
]

/**
 * Core tools (always loaded into prompt) vs deferred tools (loaded on demand via tool_search).
 * This reduces prompt size by ~30% when advanced tools aren't needed.
 */
const DEFERRED_TOOL_NAMES = new Set([
  'browser_navigate', 'browser_action', 'browser_extract', 'browser_screenshot', 'browser_close',
  'notebook_edit', 'worktree_create', 'worktree_remove',
  'ask_user', 'enter_plan_mode', 'exit_plan_mode',
])

/** Core tools — always included in the prompt. */
export const CORE_TOOLS: AgentToolDef[] = AGENT_TOOLS.filter(t => !DEFERRED_TOOL_NAMES.has(t.function.name))

/** Deferred tools — loaded on demand when agent calls tool_search. */
export const DEFERRED_TOOLS: AgentToolDef[] = AGENT_TOOLS.filter(t => DEFERRED_TOOL_NAMES.has(t.function.name))

/** Get tool schema by name (searches both core and deferred). */
export function getToolByName(name: string): AgentToolDef | undefined {
  return AGENT_TOOLS.find(t => t.function.name === name)
}

/** Search deferred tools by query. Returns matching tool definitions. */
export function searchTools(query: string): AgentToolDef[] {
  const q = query.toLowerCase()

  // Exact select: "select:browser_navigate,notebook_edit"
  if (q.startsWith('select:')) {
    const names = q.slice(7).split(',').map(s => s.trim())
    return DEFERRED_TOOLS.filter(t => names.includes(t.function.name))
  }

  // Keyword search across name + description
  return DEFERRED_TOOLS.filter(t => {
    const text = `${t.function.name} ${t.function.description}`.toLowerCase()
    return q.split(/\s+/).every(word => text.includes(word))
  })
}

/** Tools that can safely run concurrently (read-only, no side effects). */
export const CONCURRENCY_SAFE_TOOLS = new Set([
  'read_file', 'list_directory', 'search_files', 'search_content',
  'create_task_list', 'web_search', 'web_fetch',
  'ask_user', 'exit_plan_mode', 'tool_search', 'find_symbol',
  // NOTE: browser_* tools are NOT concurrency-safe — they share a mutable page object
])

export function isToolConcurrencySafe(toolName: string): boolean {
  return CONCURRENCY_SAFE_TOOLS.has(toolName)
}

export function getToolRiskLevel(toolName: string, args: any): RiskLevel {
  switch (toolName) {
    case 'read_file':
    case 'list_directory':
    case 'search_files':
    case 'search_content':
    case 'create_task_list':
    case 'web_search':
    case 'web_fetch':
    case 'browser_navigate':
    case 'browser_extract':
    case 'browser_screenshot':
    case 'browser_close':
    case 'ask_user':
    case 'enter_plan_mode':
    case 'exit_plan_mode':
    case 'tool_search':
    case 'find_symbol':
      return 'safe'
    case 'notebook_edit':
      return 'moderate'
    case 'worktree_create':
      return 'moderate'
    case 'worktree_remove':
      return 'dangerous'
    case 'browser_action':
      return 'moderate'
    case 'write_file':
      return 'moderate'
    case 'edit_file':
      if (args.path && fs.existsSync(args.path)) return 'moderate'
      return 'safe'
    case 'delete_file':
      return 'dangerous'
    case 'execute_command': {
      const cmd = (args.command || '').toLowerCase()
      const rawCmd = args.command || ''
      const dangerousKeywords = [
        'rmdir', 'format', 'pkill', 'shutdown', 'reboot',
        'eval ', 'exec ', 'sudo ', 'su ',
        // Windows dangerous
        'del /f /s /q', 'del /s /q', 'rd /s /q', 'rmdir /s /q',
        'remove-item -recurse -force', 'format-volume',
        'diskpart', 'shutdown /s', 'shutdown /r',
        'stop-process -force', 'taskkill /f',
      ]
      const dangerousRegexes = [
        /\brm\s+(-\w*[rf]|--recursive|--force)/i,
        /\bchmod\s+(-\w*R|--recursive)/i,
        /\bchown\s+(-\w*R|--recursive)/i,
        /\bmkfs\b/i,
        /\bdd\s+/i,
        /\bkill\s+-9\b/i,
        /\b(python|ruby|perl|node)\s+-(e|c)\b/i,
        /\b(bash|sh|zsh)\s+-c\b/i,
        // Shell injection patterns (fail-closed)
        /\$\(/,                            // command substitution
        /`[^`]*`/,                         // backtick substitution
        /<\(/,                             // process substitution
        />\(/,                             // process substitution
        /[\x00-\x08\x0e-\x1f\x7f]/,      // control characters
        /[\u200b-\u200f\u2028-\u202f\ufeff]/, // Unicode invisible chars
      ]
      // Zsh-specific dangerous commands
      const zshDangerous = ['zmodload', 'emulate', 'sysopen', 'sysread', 'syswrite', 'zpty', 'ztcp', 'zsocket']
      if (zshDangerous.some(z => cmd.includes(z))) return 'dangerous'

      if (dangerousKeywords.some(p => cmd.includes(p))) return 'dangerous'
      if (dangerousRegexes.some(r => r.test(rawCmd))) return 'dangerous'
      const moderatePatterns = [
        'rm ', 'mv ', 'cp ', 'install', 'uninstall',
        'pip', 'npm', 'brew', 'curl', 'wget',
        'git push', 'git reset',
        // Windows moderate
        'del ', 'move ', 'copy ', 'xcopy', 'robocopy',
        'choco ', 'scoop ', 'winget ',
        'set-executionpolicy', 'new-service',
      ]
      if (moderatePatterns.some(p => cmd.includes(p))) return 'moderate'
      return 'safe'
    }
    default:
      return 'moderate'
  }
}

function globMatch(pattern: string, filename: string): boolean {
  try {
    const regex = pattern
      // Escape regex-special characters (except * and . which are handled below)
      .replace(/[(){}+?\[\]|^$]/g, '\\$&')
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    return new RegExp(`^${regex}$`).test(filename)
  } catch {
    return false
  }
}

const SEARCH_MAX_FILE_RESULTS = 200
const SEARCH_MAX_CONTENT_RESULTS = 120
const SEARCH_MAX_FILE_DEPTH = 20
const SEARCH_MAX_CONTENT_DEPTH = 16
const SEARCH_DEFAULT_READ_BYTES = 1024 * 1024
const SEARCH_DEFAULT_READ_BYTES_WORKSPACE = 4 * 1024 * 1024
const SEARCH_MAX_READ_BYTES = 16 * 1024 * 1024
const SEARCH_YIELD_INTERVAL = 120
const SEARCH_FILES_TIMEOUT_MS = 20000
const SEARCH_CONTENT_TIMEOUT_MS = 30000
const SEARCH_FILES_TIMEOUT_MS_WORKSPACE = 90000
const SEARCH_CONTENT_TIMEOUT_MS_WORKSPACE = 150000
const SEARCH_MAX_VISITED_ENTRIES_FILES = 120000
const SEARCH_MAX_VISITED_ENTRIES_CONTENT = 80000
const SEARCH_MAX_VISITED_ENTRIES_FILES_WORKSPACE = 400000
const SEARCH_MAX_VISITED_ENTRIES_CONTENT_WORKSPACE = 240000
const SEARCH_MAX_SCANNED_FILES_CONTENT = 3000
const SEARCH_MAX_SCANNED_FILES_CONTENT_WORKSPACE = 20000
const SEARCH_MAX_TIMEOUT_MS = 10 * 60 * 1000
const SEARCH_MIN_TIMEOUT_MS = 1000

function shouldSkipSearchEntry(name: string): boolean {
  if (name.startsWith('.')) return true

  const lower = name.toLowerCase()
  if (lower === 'node_modules') return true

  // Common "huge & rarely useful for code search" bundles.
  const skippedSuffixes = ['.app', '.framework', '.dylib', '.dSYM'.toLowerCase(), '.xcarchive', '.pkg']
  if (skippedSuffixes.some(suffix => lower.endsWith(suffix))) return true

  return false
}

function normalizeRelativePath(rootDir: string, fullPath: string): string {
  return path.relative(rootDir, fullPath).split(path.sep).join('/')
}

function matchesSearchPattern(pattern: string, fileName: string, relativePath: string): boolean {
  return globMatch(pattern, fileName) || globMatch(pattern, relativePath)
}

type SearchStopReason = 'aborted' | 'timeout' | 'max_entries' | 'max_files'

interface SearchTraversalState {
  visited: number
  scannedFiles: number
  startedAt: number
  deadlineAt: number
  maxEntries: number
  maxFiles: number
  stopReason: SearchStopReason | null
  signal?: AbortSignal
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void promise.catch(() => {})
      reject(new Error('timeout'))
    }, timeoutMs)

    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Generate a short unified diff showing what changed in an edit.
 * Context: 3 lines before/after the change. Capped to ~40 lines.
 */
function generateSimpleDiff(filePath: string, oldStr: string, newStr: string, originalContent: string): string {
  const lines = originalContent.split('\n')
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')

  // Find the line number where the old_string starts
  const joinedBefore = originalContent.indexOf(oldStr)
  if (joinedBefore === -1) return ''
  const startLine = originalContent.substring(0, joinedBefore).split('\n').length

  const CONTEXT = 2
  const contextBefore = lines.slice(Math.max(0, startLine - 1 - CONTEXT), startLine - 1)
  const contextAfter = lines.slice(startLine - 1 + oldLines.length, startLine - 1 + oldLines.length + CONTEXT)

  const diffLines: string[] = []
  diffLines.push(`--- ${path.basename(filePath)}`)
  diffLines.push(`+++ ${path.basename(filePath)}`)
  diffLines.push(`@@ -${Math.max(1, startLine - CONTEXT)},${contextBefore.length + oldLines.length + contextAfter.length} +${Math.max(1, startLine - CONTEXT)},${contextBefore.length + newLines.length + contextAfter.length} @@`)
  for (const l of contextBefore) diffLines.push(` ${l}`)
  for (const l of oldLines) diffLines.push(`-${l}`)
  for (const l of newLines) diffLines.push(`+${l}`)
  for (const l of contextAfter) diffLines.push(` ${l}`)

  // Cap output
  const result = diffLines.join('\n')
  return result.length > 2000 ? result.substring(0, 2000) + '\n[diff truncated]' : result
}

function isSubPath(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath)
  const child = path.resolve(childPath)

  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function shouldStopSearch(state: SearchTraversalState): boolean {
  if (state.stopReason) return true

  if (state.signal?.aborted) {
    state.stopReason = 'aborted'
    return true
  }

  if (Date.now() >= state.deadlineAt) {
    state.stopReason = 'timeout'
    return true
  }

  if (state.visited > state.maxEntries) {
    state.stopReason = 'max_entries'
    return true
  }

  if (state.scannedFiles > state.maxFiles) {
    state.stopReason = 'max_files'
    return true
  }

  return false
}

async function maybeYieldTraversal(state: SearchTraversalState) {
  state.visited += 1
  if (shouldStopSearch(state)) return
  if (state.visited % SEARCH_YIELD_INTERVAL === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function readFileExcerpt(
  filePath: string,
  maxBytes: number,
  state: SearchTraversalState,
): Promise<{ content: string; truncated: boolean } | null> {
  try {
    if (shouldStopSearch(state)) return null
    const handle = await withTimeout(fs.promises.open(filePath, 'r'), 2000)
    try {
      if (shouldStopSearch(state)) return null
      const stats = await withTimeout(handle.stat(), 2000)
      const bytesToRead = Math.min(stats.size, maxBytes)
      const buffer = Buffer.alloc(bytesToRead)
      if (shouldStopSearch(state)) return null
      const readTimeoutMs = Math.min(15000, 2000 + Math.floor(bytesToRead / 1024))
      await withTimeout(handle.read(buffer, 0, bytesToRead, 0), readTimeoutMs)
      // Skip binary-ish files (e.g., sqlite, images) to avoid huge overhead.
      if (buffer.includes(0)) return null
      return {
        content: buffer.toString('utf-8'),
        truncated: stats.size > maxBytes,
      }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function searchFilesRecursive(
  dir: string,
  rootDir: string,
  pattern: string,
  results: string[],
  state: SearchTraversalState,
  options: { maxDepth: number; maxResults: number },
  depth = 0,
): Promise<void> {
  if (shouldStopSearch(state)) return
  if (depth > options.maxDepth || results.length >= options.maxResults) return

  let entries: fs.Dirent[] = []
  try {
    entries = await withTimeout(fs.promises.readdir(dir, { withFileTypes: true }), 8000)
  } catch {
    return
  }

  for (const entry of entries) {
    await maybeYieldTraversal(state)
    if (shouldStopSearch(state)) return
    if (shouldSkipSearchEntry(entry.name)) continue

    const fullPath = path.join(dir, entry.name)
    const relativePath = normalizeRelativePath(rootDir, fullPath)

    if (entry.isDirectory()) {
      await searchFilesRecursive(fullPath, rootDir, pattern, results, state, options, depth + 1)
    } else if (matchesSearchPattern(pattern, entry.name, relativePath)) {
      results.push(fullPath)
    }

    if (results.length >= options.maxResults) return
    if (shouldStopSearch(state)) return
  }
}

async function searchContentRecursive(
  dir: string,
  rootDir: string,
  query: string,
  filePattern: string | undefined,
  results: string[],
  state: SearchTraversalState,
  options: { maxDepth: number; maxResults: number; maxReadBytes: number },
  depth = 0,
): Promise<void> {
  if (shouldStopSearch(state)) return
  if (depth > options.maxDepth || results.length >= options.maxResults) return

  let entries: fs.Dirent[] = []
  try {
    entries = await withTimeout(fs.promises.readdir(dir, { withFileTypes: true }), 8000)
  } catch {
    return
  }

  for (const entry of entries) {
    await maybeYieldTraversal(state)
    if (shouldStopSearch(state)) return
    if (shouldSkipSearchEntry(entry.name)) continue

    const fullPath = path.join(dir, entry.name)
    const relativePath = normalizeRelativePath(rootDir, fullPath)

    if (entry.isDirectory()) {
      await searchContentRecursive(fullPath, rootDir, query, filePattern, results, state, options, depth + 1)
      if (results.length >= options.maxResults) return
      continue
    }

    if (filePattern && !matchesSearchPattern(filePattern, entry.name, relativePath)) continue

    state.scannedFiles += 1
    if (shouldStopSearch(state)) return

    const excerpt = await readFileExcerpt(fullPath, options.maxReadBytes, state)
    if (!excerpt) continue

    const lines = excerpt.content.split('\n')
    const matches: string[] = []
    // Support regex: try to compile query as regex, fallback to literal includes
    let queryRegex: RegExp | null = null
    try { queryRegex = new RegExp(query, 'i') } catch { queryRegex = null }
    lines.forEach((line, idx) => {
      const hit = queryRegex ? queryRegex.test(line) : line.includes(query)
      if (hit) {
        matches.push(`  Line ${idx + 1}: ${line.trim().substring(0, 200)}`)
      }
    })

    if (matches.length > 0) {
      const truncatedNotice = excerpt.truncated
        ? `\n  [searched first ${Math.max(1, Math.round(options.maxReadBytes / 1024))} KB only]`
        : ''
      results.push(`${fullPath}:\n${matches.slice(0, 5).join('\n')}${matches.length > 5 ? `\n  ... and ${matches.length - 5} more matches` : ''}${truncatedNotice}`)
    }

    if (results.length >= options.maxResults) return
    if (shouldStopSearch(state)) return
  }
}

const MAX_COMMAND_OUTPUT_LENGTH = 120000
const COMMAND_DEFAULT_TIMEOUT_MS = 60000
const COMMAND_MAX_TIMEOUT_MS = 600000

/**
 * Commands where exit code 1 is a normal result, not an error.
 * grep/rg: 1 = no matches found
 * diff: 1 = differences found
 * test/[: 1 = condition false
 */
const EXPECTED_EXIT1_COMMANDS = ['grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'diff', 'test', '[']

function getBaseCommand(command: string): string {
  // Extract the base command from a potentially piped/chained command.
  // Use the FIRST non-empty command segment in the pipeline (leftmost).
  const firstCmd = command
    .split(/[|;&]/)
    .map(part => part.trim())
    .find(Boolean) || command.trim()
  const parts = firstCmd.split(/\s+/)
  // Skip env var prefixes like "FOO=bar cmd"
  const cmdPart = parts.find(p => !p.includes('=')) || parts[0] || ''
  return path.basename(cmdPart)
}

function isExpectedNonZeroExit(command: string): boolean {
  const base = getBaseCommand(command)
  return EXPECTED_EXIT1_COMMANDS.includes(base)
}

function getExitCodeHint(command: string): string {
  const base = getBaseCommand(command)
  switch (base) {
    case 'grep': case 'egrep': case 'fgrep': case 'rg': case 'ripgrep':
      return 'No matches found (exit code 1 is normal for grep)'
    case 'diff':
      return 'Differences found (exit code 1 is normal for diff)'
    case 'test': case '[':
      return 'Condition evaluated to false (exit code 1 is normal for test)'
    default:
      return ''
  }
}

function appendOutputChunk(target: string[], state: { length: number; truncated: boolean }, chunk: string) {
  if (!chunk || state.length >= MAX_COMMAND_OUTPUT_LENGTH) {
    if (chunk) state.truncated = true
    return
  }

  const remaining = MAX_COMMAND_OUTPUT_LENGTH - state.length
  if (chunk.length > remaining) {
    target.push(chunk.slice(0, remaining))
    state.length = MAX_COMMAND_OUTPUT_LENGTH
    state.truncated = true
    return
  }

  target.push(chunk)
  state.length += chunk.length
}

async function runCommand(command: string, cwd: string, riskLevel: RiskLevel, timeoutMs?: number): Promise<ToolExecutionResult> {
  const effectiveTimeout = Math.min(Math.max(timeoutMs || COMMAND_DEFAULT_TIMEOUT_MS, 1000), COMMAND_MAX_TIMEOUT_MS)
  return new Promise((resolve) => {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const outputState = { length: 0, truncated: false }
    let timedOut = false
    let settled = false

    const child = spawn(command, [], {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    const timeout = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {}

      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, 5000)
    }, effectiveTimeout)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      appendOutputChunk(stdoutChunks, outputState, chunk.toString())
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      appendOutputChunk(stderrChunks, outputState, chunk.toString())
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ success: false, output: `Command failed: ${error.message}`, riskLevel })
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      const combinedOutput = [...stdoutChunks, ...stderrChunks].join('').trim()
      const truncatedSuffix = outputState.truncated ? '\n\n[Output truncated]' : ''

      if (timedOut) {
        const timeoutMessage = combinedOutput
          ? `${combinedOutput}${truncatedSuffix}\n\n[Command timed out after ${effectiveTimeout / 1000} seconds]`
          : `Command timed out after ${effectiveTimeout / 1000} seconds`
        resolve({ success: false, output: timeoutMessage, riskLevel })
        return
      }

      if (code === 0) {
        resolve({
          success: true,
          output: combinedOutput ? `${combinedOutput}${truncatedSuffix}` : '(no output)',
          riskLevel,
        })
        return
      }

      // Exit code semantics: some commands use exit 1 for normal results
      const isNormalExit1 = code === 1 && isExpectedNonZeroExit(command)
      if (isNormalExit1) {
        const hint = getExitCodeHint(command)
        resolve({
          success: true,
          output: combinedOutput
            ? `${combinedOutput}${truncatedSuffix}${hint ? `\n\n[${hint}]` : ''}`
            : hint || '(no output)',
          riskLevel,
        })
        return
      }

      const failureDetails = signal
        ? `Command terminated by signal: ${signal}`
        : `Command failed with exit code ${code}`
      const failureOutput = combinedOutput ? `${combinedOutput}${truncatedSuffix}` : failureDetails

      resolve({
        success: false,
        output: failureOutput,
        riskLevel,
      })
    })
  })
}

/**
 * Try to use ripgrep (rg) for content search. Returns formatted results or null
 * if rg is not available. ~10-100x faster than manual traversal.
 */
async function tryRipgrepSearch(
  searchRoot: string,
  query: string,
  opts: { filePattern?: string; maxResults: number; maxDepth: number; signal?: AbortSignal }
): Promise<string | null> {
  return new Promise((resolve) => {
    const rgArgs = [
      '--no-heading', '--line-number', '--color=never',
      '--max-count=5',                   // max matches per file
      `--max-depth=${opts.maxDepth}`,
      `--max-filesize=4M`,
      '-g', '!node_modules', '-g', '!.git', '-g', '!*.min.*',
    ]
    if (opts.filePattern) rgArgs.push('-g', opts.filePattern)
    rgArgs.push('--', query, searchRoot)

    let stdout = ''
    let timedOut = false
    const proc = spawn('rg', rgArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
      env: { ...process.env, RIPGREP_CONFIG_PATH: '' },
    })

    proc.on('error', () => resolve(null)) // rg not found → fallback

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 200000) stdout += chunk.toString()
    })

    if (opts.signal) {
      const onAbort = () => { proc.kill(); resolve(null) }
      opts.signal.addEventListener('abort', onAbort, { once: true })
      proc.on('close', () => opts.signal?.removeEventListener('abort', onAbort))
    }

    proc.on('close', (code) => {
      if (code === 2) { resolve(null); return } // rg error → fallback
      if (!stdout.trim()) {
        resolve(`No matches for "${query}" in ${searchRoot}`)
        return
      }

      // Parse rg output: group by file, limit to maxResults files
      const lines = stdout.split('\n').filter(Boolean)
      const fileMap = new Map<string, string[]>()
      for (const line of lines) {
        const sep = line.indexOf(':')
        if (sep < 0) continue
        const file = line.substring(0, sep)
        const rest = line.substring(sep + 1)
        if (!fileMap.has(file)) {
          if (fileMap.size >= opts.maxResults) break
          fileMap.set(file, [])
        }
        fileMap.get(file)!.push(rest)
      }

      const output = Array.from(fileMap.entries()).map(([file, matches]) => {
        const rel = path.relative(searchRoot, file)
        return `${rel}:\n${matches.map(m => `  ${m}`).join('\n')}`
      }).join('\n\n')

      resolve(`Found matches in ${fileMap.size} files:\n${output}`)
    })
  })
}

export async function executeTool(
  toolName: string,
  argsStr: string,
  workspacePath: string | null,
  options?: { signal?: AbortSignal }
): Promise<ToolExecutionResult> {
  let args: any
  try {
    args = JSON.parse(argsStr)
  } catch {
    return { success: false, output: `Invalid tool arguments: ${argsStr}`, riskLevel: 'safe' }
  }

  const riskLevel = getToolRiskLevel(toolName, args)

  try {
    if (options?.signal?.aborted) {
      return { success: false, output: 'Tool execution aborted by user.', riskLevel }
    }

    switch (toolName) {
      case 'read_file': {
        const filePath = args.path
        if (!fs.existsSync(filePath)) {
          return { success: false, output: `File not found: ${filePath}`, riskLevel }
        }

        // Non-text files (PDF, DOCX, XLSX, images, etc.) → use unified extraction
        if (isExtractableFile(filePath)) {
          const result = await extractFileContent(filePath)
          const output = result.content
            ? `${result.header}\n\n${result.content}`
            : result.header
          return { success: !!result.content, output, riskLevel }
        }

        const stat = fs.statSync(filePath)

        // Try file read cache for small text files (common case)
        const wantsLineRangeEarly = args.start_line != null || args.end_line != null
        if (!wantsLineRangeEarly && stat.size <= 5 * 1024 * 1024) {
          const cached = fileReadCache.read(filePath)
          if (cached !== null) {
            const maxLen = typeof args.max_length === 'number' ? Math.min(args.max_length, 240000) : 20000
            const output = cached.length > maxLen
              ? `${cached.substring(0, maxLen)}\n\n[File truncated — showing first ${maxLen} of ${cached.length} chars]`
              : cached
            return { success: true, output, riskLevel }
          }
        }

        const maxLengthRaw = typeof args.max_length === 'number' && Number.isFinite(args.max_length)
          ? Math.max(1, Math.floor(args.max_length))
          : 20000
        const maxLength = Math.min(maxLengthRaw, 240000)

        const startLineRaw = typeof args.start_line === 'number' && Number.isFinite(args.start_line)
          ? Math.max(1, Math.floor(args.start_line))
          : null
        const endLineRaw = typeof args.end_line === 'number' && Number.isFinite(args.end_line)
          ? Math.max(1, Math.floor(args.end_line))
          : null

        const wantsLineRange = startLineRaw !== null || endLineRaw !== null

        // If the file is large and the caller didn't ask for a line range, avoid
        // reading the entire file into memory.
        if (!wantsLineRange && stat.size > 4 * 1024 * 1024) {
          const bytesToRead = Math.min(stat.size, maxLength)
          const fd = fs.openSync(filePath, 'r')
          try {
            const buffer = Buffer.alloc(bytesToRead)
            fs.readSync(fd, buffer, 0, bytesToRead, 0)
            const excerpt = buffer.toString('utf-8')
            return {
              success: true,
              output: `${excerpt}\n\n[File truncated - large file; showing first ${bytesToRead} bytes. Use start_line/end_line or increase max_length.]`,
              riskLevel,
            }
          } finally {
            fs.closeSync(fd)
          }
        }

        const content = fs.readFileSync(filePath, 'utf-8')

        let output = content
        const notes: string[] = []

        if (wantsLineRange) {
          const lines = content.split('\n')
          const totalLines = lines.length
          const startLine = startLineRaw ?? 1
          const endLine = Math.min(endLineRaw ?? totalLines, totalLines)

          output = lines.slice(startLine - 1, endLine).join('\n')
          notes.push(`[Showing lines ${startLine}-${endLine} of ${totalLines}]`)
        }

        if (output.length > maxLength) {
          output = output.substring(0, maxLength)
          notes.push(`[File truncated - showing first ${maxLength} characters. Use start_line/end_line or increase max_length.]`)
        }

        if (notes.length > 0) {
          output = `${notes.join(' ')}\n\n${output}`
        }

        return { success: true, output, riskLevel }
      }

      case 'write_file': {
        if (workspacePath) {
          const resolvedTarget = path.resolve(args.path)
          if (!resolvedTarget.startsWith(path.resolve(workspacePath) + path.sep) && resolvedTarget !== path.resolve(workspacePath)) {
            return { success: false, output: `Path "${args.path}" is outside the workspace. File operations are restricted to: ${workspacePath}`, riskLevel }
          }
        }
        const dir = path.dirname(args.path)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(args.path, args.content, 'utf-8')
        fileReadCache.invalidate(args.path)
        return { success: true, output: `File written successfully: ${args.path}`, riskLevel }
      }

      case 'edit_file': {
        if (workspacePath) {
          const resolvedTarget = path.resolve(args.path)
          if (!resolvedTarget.startsWith(path.resolve(workspacePath) + path.sep) && resolvedTarget !== path.resolve(workspacePath)) {
            return { success: false, output: `Path "${args.path}" is outside the workspace. File operations are restricted to: ${workspacePath}`, riskLevel }
          }
        }
        if (!fs.existsSync(args.path)) {
          return { success: false, output: `File not found: ${args.path}`, riskLevel }
        }
        const originalContent = fs.readFileSync(args.path, 'utf-8')
        if (!originalContent.includes(args.old_string)) {
          return { success: false, output: `String not found in file: "${args.old_string.substring(0, 100)}"`, riskLevel }
        }
        // Uniqueness check: old_string must appear exactly once (unless replace_all)
        const occurrences = originalContent.split(args.old_string).length - 1
        if (occurrences > 1 && !args.replace_all) {
          return {
            success: false,
            output: `The old_string appears ${occurrences} times in the file. Either provide a larger unique context to match exactly once, or set replace_all=true to replace all occurrences.`,
            riskLevel,
          }
        }
        let newContent: string
        if (args.replace_all) {
          newContent = originalContent.split(args.old_string).join(args.new_string)
        } else {
          newContent = originalContent.replace(args.old_string, () => args.new_string)
        }
        fs.writeFileSync(args.path, newContent, 'utf-8')
        fileReadCache.invalidate(args.path)

        // Generate a short unified diff for agent self-verification
        const diff = generateSimpleDiff(args.path, args.old_string, args.new_string, originalContent)
        return { success: true, output: `File edited: ${args.path}${args.replace_all ? ` (${occurrences} replacements)` : ''}\n\n${diff}`, riskLevel }
      }

      case 'delete_file': {
        if (workspacePath) {
          const resolvedTarget = path.resolve(args.path)
          if (!resolvedTarget.startsWith(path.resolve(workspacePath) + path.sep) && resolvedTarget !== path.resolve(workspacePath)) {
            return { success: false, output: `Path "${args.path}" is outside the workspace. File operations are restricted to: ${workspacePath}`, riskLevel }
          }
        }
        if (!fs.existsSync(args.path)) {
          return { success: false, output: `Path not found: ${args.path}`, riskLevel }
        }
        const stat = fs.statSync(args.path)
        if (stat.isDirectory()) {
          fs.rmdirSync(args.path)
        } else {
          fs.unlinkSync(args.path)
        }
        return { success: true, output: `Deleted: ${args.path}`, riskLevel }
      }

      case 'list_directory': {
        const dirPath = args.path || workspacePath || (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || '/'
        if (!fs.existsSync(dirPath)) {
          return { success: false, output: `Directory not found: ${dirPath}`, riskLevel }
        }
        const maxDepth = Math.min(Math.max(args.depth || 1, 1), 4)
        const includeHidden = args.include_hidden || false
        // Known config dotfiles that are always useful to show
        const usefulDotfiles = new Set(['.gitignore', '.env.example', '.env.local', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.prettierrc', '.prettierrc.js', '.prettierrc.json', '.editorconfig', '.nvmrc', '.node-version', '.onit'])

        function listDir(dir: string, prefix: string, depth: number): string[] {
          if (depth > maxDepth) return []
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true })
            const filtered = entries.filter(e => {
              if (!e.name.startsWith('.')) return true
              if (includeHidden) return true
              return usefulDotfiles.has(e.name)
            }).sort((a, b) => {
              // Directories first
              if (a.isDirectory() && !b.isDirectory()) return -1
              if (!a.isDirectory() && b.isDirectory()) return 1
              return a.name.localeCompare(b.name)
            })
            const lines: string[] = []
            for (const e of filtered) {
              const icon = e.isDirectory() ? '[DIR]' : '[FILE]'
              lines.push(`${prefix}${icon} ${e.name}`)
              if (e.isDirectory() && depth < maxDepth) {
                const subLines = listDir(path.join(dir, e.name), prefix + '  ', depth + 1)
                lines.push(...subLines)
              }
            }
            return lines
          } catch { return [] }
        }

        const items = listDir(dirPath, '', 1)
        return { success: true, output: `Contents of ${dirPath}:\n${items.join('\n')}`, riskLevel }
      }

      case 'search_files': {
        const results: string[] = []
        const searchRoot = typeof args.directory === 'string' ? args.directory : workspacePath || ''
        const inWorkspace = workspacePath ? isSubPath(workspacePath, searchRoot) : false
        const defaultTimeoutMs = inWorkspace ? SEARCH_FILES_TIMEOUT_MS_WORKSPACE : SEARCH_FILES_TIMEOUT_MS
        const defaultMaxEntries = inWorkspace ? SEARCH_MAX_VISITED_ENTRIES_FILES_WORKSPACE : SEARCH_MAX_VISITED_ENTRIES_FILES

        const timeoutMs = clampNumber(args.timeout_ms, SEARCH_MIN_TIMEOUT_MS, SEARCH_MAX_TIMEOUT_MS, defaultTimeoutMs)
        const maxEntries = clampNumber(args.max_entries, 1000, 5_000_000, defaultMaxEntries)
        const maxDepth = clampNumber(args.max_depth, 0, 64, SEARCH_MAX_FILE_DEPTH)
        const maxResults = clampNumber(args.max_results, 1, 2000, SEARCH_MAX_FILE_RESULTS)

        const state: SearchTraversalState = {
          visited: 0,
          scannedFiles: 0,
          startedAt: Date.now(),
          deadlineAt: Date.now() + timeoutMs,
          maxEntries,
          maxFiles: Number.POSITIVE_INFINITY,
          stopReason: null,
          signal: options?.signal,
        }

        await searchFilesRecursive(searchRoot, searchRoot, args.pattern, results, state, { maxDepth, maxResults })
        const elapsedMs = Date.now() - state.startedAt
        const stopNotice = state.stopReason
          ? `\n\n[Search stopped early: ${state.stopReason}. Visited ${state.visited} entries in ${(elapsedMs / 1000).toFixed(1)}s. Narrow the directory or increase limits.]`
          : ''
        if (results.length === 0) {
          return { success: true, output: `No files matching "${args.pattern}" found in ${searchRoot}${stopNotice}`, riskLevel }
        }
        return { success: true, output: `Found ${results.length} files:\n${results.join('\n')}${stopNotice}`, riskLevel }
      }

      case 'search_content': {
        const searchRoot = typeof args.directory === 'string' ? args.directory : workspacePath || ''
        const maxResults = clampNumber(args.max_results, 1, 500, SEARCH_MAX_CONTENT_RESULTS)
        const maxDepth = clampNumber(args.max_depth, 0, 64, SEARCH_MAX_CONTENT_DEPTH)

        // Fast path: use ripgrep if available (10-100x faster than manual traversal)
        const rgResult = await tryRipgrepSearch(searchRoot, args.query, {
          filePattern: args.file_pattern,
          maxResults,
          maxDepth,
          signal: options?.signal,
        })
        if (rgResult !== null) {
          return { success: true, output: rgResult, riskLevel }
        }

        // Fallback: manual traversal (when rg is not installed)
        const results: string[] = []
        const inWorkspace = workspacePath ? isSubPath(workspacePath, searchRoot) : false
        const defaultTimeoutMs = inWorkspace ? SEARCH_CONTENT_TIMEOUT_MS_WORKSPACE : SEARCH_CONTENT_TIMEOUT_MS
        const defaultMaxEntries = inWorkspace ? SEARCH_MAX_VISITED_ENTRIES_CONTENT_WORKSPACE : SEARCH_MAX_VISITED_ENTRIES_CONTENT
        const defaultMaxFiles = inWorkspace ? SEARCH_MAX_SCANNED_FILES_CONTENT_WORKSPACE : SEARCH_MAX_SCANNED_FILES_CONTENT
        const defaultMaxReadBytes = inWorkspace ? SEARCH_DEFAULT_READ_BYTES_WORKSPACE : SEARCH_DEFAULT_READ_BYTES

        const timeoutMs = clampNumber(args.timeout_ms, SEARCH_MIN_TIMEOUT_MS, SEARCH_MAX_TIMEOUT_MS, defaultTimeoutMs)
        const maxEntries = clampNumber(args.max_entries, 1000, 5_000_000, defaultMaxEntries)
        const maxFiles = clampNumber(args.max_files, 10, 500_000, defaultMaxFiles)
        const maxReadBytes = clampNumber(args.max_read_bytes, 1024, SEARCH_MAX_READ_BYTES, defaultMaxReadBytes)

        const state: SearchTraversalState = {
          visited: 0,
          scannedFiles: 0,
          startedAt: Date.now(),
          deadlineAt: Date.now() + timeoutMs,
          maxEntries,
          maxFiles,
          stopReason: null,
          signal: options?.signal,
        }

        await searchContentRecursive(searchRoot, searchRoot, args.query, args.file_pattern, results, state, {
          maxDepth,
          maxResults: maxResults,
          maxReadBytes,
        })
        const elapsedMs = Date.now() - state.startedAt
        const stopNotice = state.stopReason
          ? `\n\n[Search stopped early: ${state.stopReason}. Visited ${state.visited} entries, scanned ${Math.min(state.scannedFiles, maxFiles)} files in ${(elapsedMs / 1000).toFixed(1)}s. Narrow the directory or use file_pattern.]`
          : ''
        if (results.length === 0) {
          return { success: true, output: `No matches for "${args.query}" found in ${searchRoot}${stopNotice}`, riskLevel }
        }
        return { success: true, output: `Found matches in ${results.length} files:\n${results.join('\n\n')}${stopNotice}`, riskLevel }
      }

      case 'execute_command': {
        const cwd = args.working_directory || workspacePath || (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || '/'
        return runCommand(args.command, cwd, riskLevel, args.timeout_ms)
      }

      case 'web_search': {
        return new Promise((resolve) => {
          const query = args.query || ''
          const maxResults = Math.min(args.max_results || 5, 10)

          const searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`

          fetchUrl(searchUrl, 3, (err, body) => {
            if (err) {
              resolve({ success: false, output: `Search request failed: ${err}`, riskLevel })
              return
            }
            try {
              const results = parseBingResults(body || '', maxResults)
              if (results.length === 0) {
                resolve({ success: true, output: `No results found for: "${query}"`, riskLevel })
              } else {
                const formatted = results.map((r, i) =>
                  `${i + 1}. ${r.title}\n   ${r.snippet}\n   URL: ${r.url}`
                ).join('\n\n')
                resolve({ success: true, output: `Search results for "${query}":\n\n${formatted}`, riskLevel })
              }
            } catch {
              resolve({ success: false, output: `Failed to parse search results for: "${query}"`, riskLevel })
            }
          }, options?.signal)
        })
      }

      case 'web_fetch': {
        return new Promise((resolve) => {
          const targetUrl = args.url || ''
          const maxLength = args.max_length || 20000

          // Check URL cache (15-minute TTL)
          const cached = webFetchCache.get(targetUrl)
          if (cached && Date.now() - cached.timestamp < WEB_FETCH_CACHE_TTL_MS) {
            let text = cached.text
            if (text.length > maxLength) text = text.substring(0, maxLength) + '\n\n[Content truncated]'
            resolve({ success: true, output: `Content from ${targetUrl} (cached):\n\n${text}`, riskLevel })
            return
          }

          fetchUrl(targetUrl, 5, (err, body) => {
            if (err) {
              resolve({ success: false, output: `Failed to fetch URL: ${err}`, riskLevel })
              return
            }
            // Strip HTML tags and extract text
            let text = (body || '')
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\s+/g, ' ')
              .trim()

            if (text.length > maxLength) {
              text = text.substring(0, maxLength) + '\n\n[Content truncated]'
            }

            if (!text) {
              resolve({ success: false, output: `No readable content found at: ${targetUrl}`, riskLevel })
            } else {
              // Cache the clean text for future requests (delete+set to update insertion order for LRU)
              webFetchCache.delete(targetUrl)
              webFetchCache.set(targetUrl, { text, timestamp: Date.now() })
              // Evict oldest entries if cache is too large
              if (webFetchCache.size > WEB_FETCH_CACHE_MAX_ENTRIES) {
                const oldest = webFetchCache.keys().next().value
                if (oldest) webFetchCache.delete(oldest)
              }
              resolve({ success: true, output: `Content from ${targetUrl}:\n\n${text}`, riskLevel })
            }
          }, options?.signal)
        })
      }

      case 'create_task_list': {
        return { success: true, output: JSON.stringify(args.tasks), riskLevel: 'safe' }
      }

      case 'find_symbol': {
        const symbol = args.symbol
        const dir = args.directory || workspacePath || ''
        const mode = args.mode || 'all'
        if (!symbol) return { success: false, output: 'Symbol name is required', riskLevel: 'safe' }
        if (!fs.existsSync(dir)) return { success: false, output: `Directory not found: ${dir}`, riskLevel: 'safe' }

        // Escape regex special chars to prevent injection
        const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const results: string[] = []

        // Definition patterns: function/class/const/let/var/type/interface/export declarations
        if (mode === 'definition' || mode === 'all') {
          const defPatterns = [
            `(function|class|const|let|var|type|interface|enum)\\s+${esc}\\b`,
            `export\\s+(default\\s+)?(function|class|const|let|var|type|interface|enum)\\s+${esc}\\b`,
            `${esc}\\s*[:=]\\s*(function|\\()`,  // obj.method = function / method: (
            `def\\s+${esc}\\s*\\(`,               // Python
          ]
          for (const pat of defPatterns) {
            const defResult = await tryRipgrepSearch(dir, pat, {
              maxResults: 10, maxDepth: 20, signal: options?.signal,
            })
            if (defResult && !defResult.includes('No matches')) {
              results.push(`## Definitions\n${defResult}`)
              break
            }
          }
        }

        // Reference patterns: all occurrences (excluding definitions)
        if (mode === 'references' || mode === 'all') {
          const refResult = await tryRipgrepSearch(dir, `\\b${esc}\\b`, {
            maxResults: 20, maxDepth: 20, signal: options?.signal,
          })
          if (refResult && !refResult.includes('No matches')) {
            results.push(`## References\n${refResult}`)
          }
        }

        if (results.length === 0) {
          // Fallback to simple text search
          const fallback = await tryRipgrepSearch(dir, symbol, {
            maxResults: 15, maxDepth: 20, signal: options?.signal,
          })
          return { success: true, output: fallback || `Symbol "${symbol}" not found in ${dir}`, riskLevel: 'safe' }
        }

        return { success: true, output: results.join('\n\n'), riskLevel: 'safe' }
      }

      case 'tool_search': {
        const results = searchTools(args.query || '')
        if (results.length === 0) {
          return { success: true, output: `No tools found matching "${args.query}". Available deferred tools: ${DEFERRED_TOOLS.map(t => t.function.name).join(', ')}`, riskLevel: 'safe' }
        }
        const schemas = results.map(t => JSON.stringify({ type: t.type, function: t.function }, null, 2))
        return { success: true, output: `Found ${results.length} tool(s):\n\n${schemas.join('\n\n')}`, riskLevel: 'safe' }
      }

      case 'notebook_edit': {
        const nbPath = args.path
        if (!fs.existsSync(nbPath)) {
          return { success: false, output: `Notebook not found: ${nbPath}`, riskLevel }
        }
        if (workspacePath) {
          const resolved = path.resolve(nbPath)
          if (!resolved.startsWith(path.resolve(workspacePath) + path.sep) && resolved !== path.resolve(workspacePath)) {
            return { success: false, output: `Path outside workspace: ${nbPath}`, riskLevel }
          }
        }
        try {
          const raw = fs.readFileSync(nbPath, 'utf-8')
          const nb = JSON.parse(raw)
          if (!Array.isArray(nb.cells)) {
            return { success: false, output: 'Invalid notebook: no cells array', riskLevel }
          }
          const action = args.action
          const idx = typeof args.cell_index === 'number' ? args.cell_index : -1
          if (action === 'delete') {
            if (idx < 0 || idx >= nb.cells.length) {
              return { success: false, output: `Cell index ${idx} out of range (0-${nb.cells.length - 1})`, riskLevel }
            }
            nb.cells.splice(idx, 1)
          } else if (action === 'insert') {
            const cell = { cell_type: args.cell_type || 'code', source: (args.source || '').split('\n').map((l: string) => l + '\n'), metadata: {}, outputs: [] }
            if (idx < 0 || idx >= nb.cells.length) {
              nb.cells.push(cell) // append
            } else {
              nb.cells.splice(idx, 0, cell)
            }
          } else if (action === 'replace') {
            if (idx < 0 || idx >= nb.cells.length) {
              return { success: false, output: `Cell index ${idx} out of range (0-${nb.cells.length - 1})`, riskLevel }
            }
            nb.cells[idx].cell_type = args.cell_type || nb.cells[idx].cell_type
            nb.cells[idx].source = (args.source || '').split('\n').map((l: string) => l + '\n')
            nb.cells[idx].outputs = [] // clear outputs on replace
          } else {
            return { success: false, output: `Unknown action: ${action}`, riskLevel }
          }
          fs.writeFileSync(nbPath, JSON.stringify(nb, null, 1), 'utf-8')
          fileReadCache.invalidate(nbPath)
          return { success: true, output: `Notebook ${action}ed cell at index ${idx}. Total cells: ${nb.cells.length}`, riskLevel }
        } catch (e: any) {
          return { success: false, output: `Notebook edit failed: ${e.message}`, riskLevel }
        }
      }

      case 'worktree_create': {
        const branch = args.branch
        if (!branch || !/^[\w./-]+$/.test(branch)) {
          return { success: false, output: `Invalid branch name: ${branch}`, riskLevel }
        }
        const repoRoot = workspacePath || process.cwd()
        const wtPath = args.path || path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-${branch}`)
        try {
          // Use execFileSync (not execSync) to avoid shell injection
          const { execFileSync } = require('child_process')
          execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, stdio: 'pipe' })
          // Create branch if it doesn't exist
          try { execFileSync('git', ['branch', branch], { cwd: repoRoot, stdio: 'pipe' }) } catch {}
          // Create worktree
          execFileSync('git', ['worktree', 'add', wtPath, branch], { cwd: repoRoot, stdio: 'pipe' })
          return { success: true, output: `Worktree created at: ${wtPath}\nBranch: ${branch}\n\nYou can now use this path as a workspace for isolated work.`, riskLevel }
        } catch (e: any) {
          return { success: false, output: `Worktree creation failed: ${e.message}`, riskLevel }
        }
      }

      case 'worktree_remove': {
        const wtPath = args.path
        if (!wtPath) return { success: false, output: 'Path is required', riskLevel }
        try {
          const { execFileSync } = require('child_process')
          execFileSync('git', ['worktree', 'remove', wtPath, '--force'], { cwd: workspacePath || process.cwd(), stdio: 'pipe' })
          return { success: true, output: `Worktree removed: ${wtPath}`, riskLevel }
        } catch (e: any) {
          return { success: false, output: `Worktree removal failed: ${e.message}`, riskLevel }
        }
      }

      default:
        return { success: false, output: `Unknown tool: ${toolName}`, riskLevel: 'safe' }
    }
  } catch (error: any) {
    return { success: false, output: `Tool execution error: ${error.message}`, riskLevel }
  }
}

interface SearchResult {
  title: string
  snippet: string
  url: string
}

function parseBingResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // Bing wraps each result in <li class="b_algo">
  const resultPattern = /<li class="b_algo">([\s\S]*?)<\/li>/gi
  let match: RegExpExecArray | null

  while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
    const block = match[1]

    // Extract URL and title from <h2><a href="...">title</a></h2>
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkMatch) continue

    const url = linkMatch[1]
    const title = linkMatch[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()

    // Extract snippet from <p> or <div class="b_caption"><p>
    let snippet = ''
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    if (snippetMatch) {
      snippet = snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
    }

    if (title && url) {
      results.push({ title, snippet: snippet.substring(0, 300), url })
    }
  }

  // Fallback: if b_algo parsing failed, try a broader pattern
  if (results.length === 0) {
    const fallbackPattern = /<h2[^>]*>\s*<a[^>]*href="(https?:\/\/(?!go\.microsoft|www\.bing)[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/gi
    while ((match = fallbackPattern.exec(html)) !== null && results.length < maxResults) {
      const url = match[1]
      const title = match[2].replace(/<[^>]+>/g, '').trim()
      if (title.length < 3) continue
      results.push({ title, snippet: '', url })
    }
  }

  return results
}

const BROWSER_HEADERS = {
  'User-Agent': process.platform === 'win32'
    ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': process.platform === 'win32' ? '"Windows"' : '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
}

function fetchUrl(
  targetUrl: string,
  maxRedirects: number,
  callback: (err: string | null, body: string | null) => void,
  signal?: AbortSignal
): void {
  if (signal?.aborted) {
    callback('Aborted', null)
    return
  }
  if (maxRedirects < 0) {
    callback('Too many redirects', null)
    return
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(targetUrl)
  } catch {
    callback(`Invalid URL: ${targetUrl}`, null)
    return
  }

  const httpModule = parsedUrl.protocol === 'https:' ? https : http
  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: {
      ...BROWSER_HEADERS,
      'Host': parsedUrl.hostname,
      'Referer': `${parsedUrl.protocol}//${parsedUrl.hostname}/`,
    },
  }

  let callbackFired = false
  const safeCallback = (err: string | null, body: string | null) => {
    if (callbackFired) return
    callbackFired = true
    callback(err, body)
  }

  const req = httpModule.get(options, (res) => {
    // Handle redirects
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      let redirectUrl = res.headers.location
      if (redirectUrl.startsWith('/')) {
        redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`
      } else if (!redirectUrl.startsWith('http')) {
        redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}/${redirectUrl}`
      }
      res.resume()
      fetchUrl(redirectUrl, maxRedirects - 1, callback, signal)
      return
    }

    if (res.statusCode && res.statusCode >= 400) {
      res.resume()
      safeCallback(`HTTP ${res.statusCode}`, null)
      return
    }

    const chunks: Buffer[] = []
    let totalSize = 0
    const maxSize = 5 * 1024 * 1024

    res.on('data', (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > maxSize) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    res.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8')
      safeCallback(null, body)
    })

    res.on('error', (err) => {
      safeCallback(err.message, null)
    })
  })

  req.on('error', (err) => {
    safeCallback(err.message, null)
  })

  // Abort support: destroy the request when the signal fires
  if (signal) {
    const onAbort = () => { req.destroy(); safeCallback('Aborted', null) }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => signal.removeEventListener('abort', onAbort))
  }

  req.setTimeout(15000, () => {
    req.destroy()
    safeCallback('Request timed out after 15 seconds', null)
  })
}
