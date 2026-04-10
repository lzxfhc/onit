/**
 * Hooks System — user-configurable lifecycle hooks for agent tool execution.
 *
 * Hooks are defined in a project-level `.onit/hooks.json` or the global
 * app data `onit/onit-data/hooks.json` file.
 *
 * Format:
 * {
 *   "preToolUse": [
 *     {
 *       "matcher": "execute_command",      // tool name to match (optional, default: all)
 *       "command": "echo checking...",      // shell command to run
 *       "timeout": 10000,                   // ms, default 30000
 *       "if": "execute_command(git:*)"      // content-level match (optional)
 *     }
 *   ],
 *   "postToolUse": [
 *     {
 *       "matcher": "write_file",
 *       "command": "npx eslint --fix ${path}",
 *       "timeout": 30000
 *     }
 *   ]
 * }
 *
 * Hook commands receive environment variables:
 *   ONIT_TOOL_NAME, ONIT_TOOL_ARGS (JSON), ONIT_TOOL_RESULT (postToolUse only),
 *   ONIT_SESSION_ID, ONIT_WORKSPACE
 *
 * Hook stdout is captured. Exit code 0 = success, 1 = block (preToolUse only),
 * other = ignored.
 */

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { parseToolArgs } from './tools'

export interface HookDef {
  matcher?: string       // tool name to match (e.g., "execute_command", "write_file")
  command: string        // shell command to execute
  timeout?: number       // ms, default 30000
  if?: string            // content-level match (e.g., "execute_command(git:*)")
}

export interface HooksConfig {
  preToolUse?: HookDef[]
  postToolUse?: HookDef[]
}

interface HookContext {
  toolName: string
  toolArgs: string       // raw JSON string
  toolResult?: string    // for postToolUse only
  sessionId: string
  workspacePath: string | null
}

const DEFAULT_TIMEOUT = 30000

function getGlobalDataDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'onit', 'onit-data')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'onit', 'onit-data')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'onit', 'onit-data')
}

function quoteHookValue(value: string): string {
  const sanitized = String(value).replace(/[\x00-\x1f\x7f]/g, '')

  if (process.platform === 'win32') {
    return `"${sanitized
      .replace(/%/g, '%%')
      .replace(/"/g, '""')}"`
  }

  return `'${sanitized.replace(/'/g, `'\\''`)}'`
}

export class HooksManager {
  private config: HooksConfig = {}
  private loaded = false

  /**
   * Load hooks from workspace .onit/hooks.json or global config.
   * Call this once per session or when workspace changes.
   */
  loadHooks(workspacePath: string | null): void {
    this.config = {}
    this.loaded = true

    const candidates: string[] = []

    // Project-level hooks (highest priority)
    if (workspacePath) {
      candidates.push(path.join(workspacePath, '.onit', 'hooks.json'))
    }

    // Global hooks
    candidates.push(path.join(getGlobalDataDir(), 'hooks.json'))

    for (const filePath of candidates) {
      try {
        if (fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, 'utf-8')
          const parsed = JSON.parse(raw)
          this.config = {
            preToolUse: Array.isArray(parsed.preToolUse) ? parsed.preToolUse : [],
            postToolUse: Array.isArray(parsed.postToolUse) ? parsed.postToolUse : [],
          }
          return // first found wins
        }
      } catch {
        // Invalid JSON or read error — skip
      }
    }
  }

  hasHooks(): boolean {
    return (this.config.preToolUse?.length || 0) > 0 || (this.config.postToolUse?.length || 0) > 0
  }

  /**
   * Run preToolUse hooks. Returns 'allow' to proceed, 'deny' to block.
   */
  async runPreToolUse(ctx: HookContext): Promise<'allow' | 'deny'> {
    if (!this.config.preToolUse?.length) return 'allow'

    for (const hook of this.config.preToolUse) {
      if (!this.matchesHook(hook, ctx)) continue

      const result = await this.executeHook(hook, ctx)
      if (result.exitCode === 1) return 'deny'
    }

    return 'allow'
  }

  /**
   * Run postToolUse hooks (fire-and-forget, never blocks).
   */
  async runPostToolUse(ctx: HookContext): Promise<void> {
    if (!this.config.postToolUse?.length) return

    for (const hook of this.config.postToolUse) {
      if (!this.matchesHook(hook, ctx)) continue

      try {
        await this.executeHook(hook, ctx)
      } catch {
        // Post hooks are best-effort
      }
    }
  }

  private matchesHook(hook: HookDef, ctx: HookContext): boolean {
    // Tool name matcher
    if (hook.matcher && hook.matcher !== ctx.toolName) return false

    // Content-level if condition: "execute_command(git:*)"
    if (hook.if) {
      const match = hook.if.match(/^(\w+)\((.+)\)$/)
      if (match) {
        const [, tool, pattern] = match
        if (tool !== ctx.toolName) return false

        const parsed = parseToolArgs(ctx.toolArgs, ctx.toolName)
        const args = parsed.ok ? parsed.args : {}
        const content = args.command || args.path || args.url || ''

        if (pattern.endsWith(':*')) {
          const prefix = pattern.slice(0, -2)
          if (!content.startsWith(prefix) && !content.toLowerCase().startsWith(prefix.toLowerCase())) return false
        } else if (!content.includes(pattern)) {
          return false
        }
      }
    }

    return true
  }

  private executeHook(hook: HookDef, ctx: HookContext): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const timeout = hook.timeout || DEFAULT_TIMEOUT

    // Substitute ${path}, ${command} etc. in the hook command (shell-escaped)
    let command = hook.command
    const parsed = parseToolArgs(ctx.toolArgs, ctx.toolName)
    if (parsed.ok) {
      const args = parsed.args
      command = command.replace(/\$\{(\w+)\}/g, (_: string, key: string) => {
        const value = args[key] || ''
        return quoteHookValue(value)
      })
    }

    return new Promise((resolve) => {
      const shellCommand = process.platform === 'win32'
        ? { file: 'cmd.exe', args: ['/d', '/s', '/c', command] }
        : { file: 'sh', args: ['-c', command] }

      const proc = spawn(shellCommand.file, shellCommand.args, {
        env: {
          ...process.env,
          ONIT_TOOL_NAME: ctx.toolName,
          ONIT_TOOL_ARGS: ctx.toolArgs,
          ONIT_TOOL_RESULT: ctx.toolResult || '',
          ONIT_SESSION_ID: ctx.sessionId,
          ONIT_WORKSPACE: ctx.workspacePath || '',
        },
        cwd: ctx.workspacePath || undefined,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: process.platform === 'win32',
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

      proc.on('close', (code) => {
        resolve({ exitCode: code ?? 0, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000) })
      })

      proc.on('error', () => {
        resolve({ exitCode: -1, stdout, stderr })
      })
    })
  }
}
