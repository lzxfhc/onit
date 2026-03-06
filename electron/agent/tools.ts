import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
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
]

export function getToolRiskLevel(toolName: string, args: any): RiskLevel {
  switch (toolName) {
    case 'read_file':
    case 'list_directory':
    case 'search_files':
    case 'search_content':
    case 'create_task_list':
      return 'safe'
    case 'write_file':
    case 'edit_file':
      if (args.path && fs.existsSync(args.path)) return 'moderate'
      return 'safe'
    case 'delete_file':
      return 'dangerous'
    case 'execute_command': {
      const cmd = (args.command || '').toLowerCase()
      const dangerousPatterns = ['rm -rf', 'rm -r', 'rmdir', 'format', 'mkfs', 'dd if=', 'chmod -R', 'chown -R', 'kill -9', 'pkill', 'shutdown', 'reboot']
      if (dangerousPatterns.some(p => cmd.includes(p))) return 'dangerous'
      const moderatePatterns = ['rm ', 'mv ', 'cp ', 'install', 'uninstall', 'pip', 'npm', 'brew', 'curl', 'wget', 'git push', 'git reset']
      if (moderatePatterns.some(p => cmd.includes(p))) return 'moderate'
      return 'safe'
    }
    default:
      return 'moderate'
  }
}

function globMatch(pattern: string, filename: string): boolean {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
  return new RegExp(`^${regex}$`).test(filename)
}

function searchFilesRecursive(dir: string, pattern: string, results: string[], maxDepth = 10, depth = 0): void {
  if (depth > maxDepth) return
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        searchFilesRecursive(fullPath, pattern, results, maxDepth, depth + 1)
      } else if (globMatch(pattern, entry.name)) {
        results.push(fullPath)
      }
      if (results.length >= 100) return
    }
  } catch { /* ignore permission errors */ }
}

function searchContentRecursive(dir: string, query: string, filePattern: string | undefined, results: string[], maxDepth = 8, depth = 0): void {
  if (depth > maxDepth) return
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        searchContentRecursive(fullPath, query, filePattern, results, maxDepth, depth + 1)
      } else {
        if (filePattern && !globMatch(filePattern, entry.name)) continue
        try {
          const content = fs.readFileSync(fullPath, 'utf-8')
          const lines = content.split('\n')
          const matches: string[] = []
          lines.forEach((line, idx) => {
            if (line.includes(query)) {
              matches.push(`  Line ${idx + 1}: ${line.trim().substring(0, 200)}`)
            }
          })
          if (matches.length > 0) {
            results.push(`${fullPath}:\n${matches.slice(0, 5).join('\n')}${matches.length > 5 ? `\n  ... and ${matches.length - 5} more matches` : ''}`)
          }
        } catch { /* skip binary files */ }
      }
      if (results.length >= 50) return
    }
  } catch { /* ignore */ }
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
        const dirPath = args.path || workspacePath || process.env.HOME || '/'
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
        searchFilesRecursive(args.directory, args.pattern, results)
        if (results.length === 0) {
          return { success: true, output: `No files matching "${args.pattern}" found in ${args.directory}`, riskLevel }
        }
        return { success: true, output: `Found ${results.length} files:\n${results.join('\n')}`, riskLevel }
      }

      case 'search_content': {
        const results: string[] = []
        searchContentRecursive(args.directory, args.query, args.file_pattern, results)
        if (results.length === 0) {
          return { success: true, output: `No matches for "${args.query}" found in ${args.directory}`, riskLevel }
        }
        return { success: true, output: `Found matches in ${results.length} files:\n${results.join('\n\n')}`, riskLevel }
      }

      case 'execute_command': {
        return new Promise((resolve) => {
          const cwd = args.working_directory || workspacePath || process.env.HOME || '/'
          const child = exec(args.command, {
            cwd,
            timeout: 60000,
            maxBuffer: 1024 * 1024 * 5,
            env: { ...process.env, FORCE_COLOR: '0' },
          }, (error, stdout, stderr) => {
            const output = [stdout, stderr].filter(Boolean).join('\n').trim()
            if (error && !output) {
              resolve({ success: false, output: `Command failed: ${error.message}`, riskLevel })
            } else {
              resolve({
                success: !error,
                output: output || '(no output)',
                riskLevel,
              })
            }
          })
          // Safety: kill if takes too long
          setTimeout(() => {
            try { child.kill('SIGTERM') } catch {}
          }, 60000)
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
