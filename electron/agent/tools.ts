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

const SEARCH_MAX_FILE_RESULTS = 100
const SEARCH_MAX_CONTENT_RESULTS = 50
const SEARCH_MAX_FILE_DEPTH = 10
const SEARCH_MAX_CONTENT_DEPTH = 8
const SEARCH_MAX_READ_BYTES = 512 * 1024
const SEARCH_YIELD_INTERVAL = 120

function shouldSkipSearchEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

function normalizeRelativePath(rootDir: string, fullPath: string): string {
  return path.relative(rootDir, fullPath).split(path.sep).join('/')
}

function matchesSearchPattern(pattern: string, fileName: string, relativePath: string): boolean {
  return globMatch(pattern, fileName) || globMatch(pattern, relativePath)
}

async function maybeYieldTraversal(state: { visited: number }) {
  state.visited += 1
  if (state.visited % SEARCH_YIELD_INTERVAL === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function readFileExcerpt(filePath: string, maxBytes: number): Promise<{ content: string; truncated: boolean } | null> {
  try {
    const handle = await fs.promises.open(filePath, 'r')
    try {
      const stats = await handle.stat()
      const bytesToRead = Math.min(stats.size, maxBytes)
      const buffer = Buffer.alloc(bytesToRead)
      await handle.read(buffer, 0, bytesToRead, 0)
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
  state: { visited: number },
  maxDepth = SEARCH_MAX_FILE_DEPTH,
  depth = 0,
): Promise<void> {
  if (depth > maxDepth || results.length >= SEARCH_MAX_FILE_RESULTS) return

  let entries: fs.Dirent[] = []
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    await maybeYieldTraversal(state)
    if (shouldSkipSearchEntry(entry.name)) continue

    const fullPath = path.join(dir, entry.name)
    const relativePath = normalizeRelativePath(rootDir, fullPath)

    if (entry.isDirectory()) {
      await searchFilesRecursive(fullPath, rootDir, pattern, results, state, maxDepth, depth + 1)
    } else if (matchesSearchPattern(pattern, entry.name, relativePath)) {
      results.push(fullPath)
    }

    if (results.length >= SEARCH_MAX_FILE_RESULTS) return
  }
}

async function searchContentRecursive(
  dir: string,
  rootDir: string,
  query: string,
  filePattern: string | undefined,
  results: string[],
  state: { visited: number },
  maxDepth = SEARCH_MAX_CONTENT_DEPTH,
  depth = 0,
): Promise<void> {
  if (depth > maxDepth || results.length >= SEARCH_MAX_CONTENT_RESULTS) return

  let entries: fs.Dirent[] = []
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    await maybeYieldTraversal(state)
    if (shouldSkipSearchEntry(entry.name)) continue

    const fullPath = path.join(dir, entry.name)
    const relativePath = normalizeRelativePath(rootDir, fullPath)

    if (entry.isDirectory()) {
      await searchContentRecursive(fullPath, rootDir, query, filePattern, results, state, maxDepth, depth + 1)
      if (results.length >= SEARCH_MAX_CONTENT_RESULTS) return
      continue
    }

    if (filePattern && !matchesSearchPattern(filePattern, entry.name, relativePath)) continue

    const excerpt = await readFileExcerpt(fullPath, SEARCH_MAX_READ_BYTES)
    if (!excerpt) continue

    const lines = excerpt.content.split('\n')
    const matches: string[] = []
    lines.forEach((line, idx) => {
      if (line.includes(query)) {
        matches.push(`  Line ${idx + 1}: ${line.trim().substring(0, 200)}`)
      }
    })

    if (matches.length > 0) {
      const truncatedNotice = excerpt.truncated ? '\n  [searched first 512 KB only]' : ''
      results.push(`${fullPath}:\n${matches.slice(0, 5).join('\n')}${matches.length > 5 ? `\n  ... and ${matches.length - 5} more matches` : ''}${truncatedNotice}`)
    }

    if (results.length >= SEARCH_MAX_CONTENT_RESULTS) return
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
  workspacePath: string | null
): Promise<ToolExecutionResult> {
  let args: any
  try {
    args = JSON.parse(argsStr)
  } catch {
    return { success: false, output: `Invalid tool arguments: ${argsStr}`, riskLevel: 'safe' }
  }

  const riskLevel = getToolRiskLevel(toolName, args)

  try {
    switch (toolName) {
      case 'read_file': {
        const filePath = args.path
        if (!fs.existsSync(filePath)) {
          return { success: false, output: `File not found: ${filePath}`, riskLevel }
        }
        const stat = fs.statSync(filePath)
        if (stat.size > 1024 * 1024) {
          const content = fs.readFileSync(filePath, 'utf-8').substring(0, 50000)
          return { success: true, output: content + '\n\n[File truncated - showing first 50000 characters]', riskLevel }
        }
        const content = fs.readFileSync(filePath, 'utf-8')
        return { success: true, output: content, riskLevel }
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
        await searchFilesRecursive(args.directory, args.directory, args.pattern, results, { visited: 0 })
        if (results.length === 0) {
          return { success: true, output: `No files matching "${args.pattern}" found in ${args.directory}`, riskLevel }
        }
        return { success: true, output: `Found ${results.length} files:\n${results.join('\n')}`, riskLevel }
      }

      case 'search_content': {
        const results: string[] = []
        await searchContentRecursive(args.directory, args.directory, args.query, args.file_pattern, results, { visited: 0 })
        if (results.length === 0) {
          return { success: true, output: `No matches for "${args.query}" found in ${args.directory}`, riskLevel }
        }
        return { success: true, output: `Found matches in ${results.length} files:\n${results.join('\n\n')}`, riskLevel }
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
