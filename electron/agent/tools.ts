import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import { AgentToolDef, ToolExecutionResult, RiskLevel } from './types'

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
      description: 'Edit a file by replacing a specific string with a new string. The old_string must be unique in the file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to edit' },
          old_string: { type: 'string', description: 'The exact string to find and replace' },
          new_string: { type: 'string', description: 'The string to replace it with' },
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
      description: 'List the contents of a directory, showing files and subdirectories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory to list' },
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
      description: 'Execute a shell command and return its output. Use for running scripts, installing packages, git operations, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          working_directory: { type: 'string', description: 'Working directory for the command (optional)' },
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
]

export function getToolRiskLevel(toolName: string, args: any): RiskLevel {
  switch (toolName) {
    case 'read_file':
    case 'list_directory':
    case 'search_files':
    case 'search_content':
    case 'create_task_list':
    case 'web_search':
    case 'web_fetch':
      return 'safe'
    case 'write_file':
    case 'edit_file':
      if (args.path && fs.existsSync(args.path)) return 'moderate'
      return 'safe'
    case 'delete_file':
      return 'dangerous'
    case 'execute_command': {
      const cmd = (args.command || '').toLowerCase()
      const dangerousPatterns = [
        'rm -rf', 'rm -r', 'rmdir', 'format', 'mkfs', 'dd if=',
        'chmod -R', 'chown -R', 'kill -9', 'pkill', 'shutdown', 'reboot',
        // Windows dangerous
        'del /f /s /q', 'del /s /q', 'rd /s /q', 'rmdir /s /q',
        'remove-item -recurse -force', 'format-volume',
        'diskpart', 'shutdown /s', 'shutdown /r',
        'stop-process -force', 'taskkill /f',
      ]
      if (dangerousPatterns.some(p => cmd.includes(p))) return 'dangerous'
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
  const regex = pattern
    .replace(/\./g, '\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
  return new RegExp(`^${regex}$`).test(filename)
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
    lines.forEach((line, idx) => {
      if (line.includes(query)) {
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
const COMMAND_TIMEOUT_MS = 60000

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

async function runCommand(command: string, cwd: string, riskLevel: RiskLevel): Promise<ToolExecutionResult> {
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
    }, COMMAND_TIMEOUT_MS)

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
          ? `${combinedOutput}${truncatedSuffix}\n\n[Command timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds]`
          : `Command timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds`
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
        const stat = fs.statSync(filePath)

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
        const dir = path.dirname(args.path)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(args.path, args.content, 'utf-8')
        return { success: true, output: `File written successfully: ${args.path}`, riskLevel }
      }

      case 'edit_file': {
        if (!fs.existsSync(args.path)) {
          return { success: false, output: `File not found: ${args.path}`, riskLevel }
        }
        let content = fs.readFileSync(args.path, 'utf-8')
        if (!content.includes(args.old_string)) {
          return { success: false, output: `String not found in file: "${args.old_string.substring(0, 100)}"`, riskLevel }
        }
        content = content.replace(args.old_string, args.new_string)
        fs.writeFileSync(args.path, content, 'utf-8')
        return { success: true, output: `File edited successfully: ${args.path}`, riskLevel }
      }

      case 'delete_file': {
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
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        const items = entries
          .filter(e => !e.name.startsWith('.'))
          .map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`)
          .sort()
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
        const results: string[] = []
        const searchRoot = typeof args.directory === 'string' ? args.directory : workspacePath || ''
        const inWorkspace = workspacePath ? isSubPath(workspacePath, searchRoot) : false
        const defaultTimeoutMs = inWorkspace ? SEARCH_CONTENT_TIMEOUT_MS_WORKSPACE : SEARCH_CONTENT_TIMEOUT_MS
        const defaultMaxEntries = inWorkspace ? SEARCH_MAX_VISITED_ENTRIES_CONTENT_WORKSPACE : SEARCH_MAX_VISITED_ENTRIES_CONTENT
        const defaultMaxFiles = inWorkspace ? SEARCH_MAX_SCANNED_FILES_CONTENT_WORKSPACE : SEARCH_MAX_SCANNED_FILES_CONTENT
        const defaultMaxReadBytes = inWorkspace ? SEARCH_DEFAULT_READ_BYTES_WORKSPACE : SEARCH_DEFAULT_READ_BYTES

        const timeoutMs = clampNumber(args.timeout_ms, SEARCH_MIN_TIMEOUT_MS, SEARCH_MAX_TIMEOUT_MS, defaultTimeoutMs)
        const maxEntries = clampNumber(args.max_entries, 1000, 5_000_000, defaultMaxEntries)
        const maxDepth = clampNumber(args.max_depth, 0, 64, SEARCH_MAX_CONTENT_DEPTH)
        const maxResults = clampNumber(args.max_results, 1, 500, SEARCH_MAX_CONTENT_RESULTS)
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
          maxResults,
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
        return runCommand(args.command, cwd, riskLevel)
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
          })
        })
      }

      case 'web_fetch': {
        return new Promise((resolve) => {
          const targetUrl = args.url || ''
          const maxLength = args.max_length || 20000

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
              resolve({ success: true, output: `Content from ${targetUrl}:\n\n${text}`, riskLevel })
            }
          })
        })
      }

      case 'create_task_list': {
        return { success: true, output: JSON.stringify(args.tasks), riskLevel: 'safe' }
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
  callback: (err: string | null, body: string | null) => void
): void {
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
      fetchUrl(redirectUrl, maxRedirects - 1, callback)
      return
    }

    if (res.statusCode && res.statusCode >= 400) {
      res.resume()
      callback(`HTTP ${res.statusCode}`, null)
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
      callback(null, body)
    })

    res.on('error', (err) => {
      callback(err.message, null)
    })
  })

  req.on('error', (err) => {
    callback(err.message, null)
  })

  req.setTimeout(15000, () => {
    req.destroy()
    callback('Request timed out after 15 seconds', null)
  })
}
