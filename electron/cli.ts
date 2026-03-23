/**
 * Onit CLI Mode
 *
 * Every GUI feature has a CLI equivalent. Shares the same AgentManager,
 * SkillManager, SchedulerManager, SkillEvolutionManager, and LocalModelManager.
 */

import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import * as readline from 'readline'
import type { AgentManager } from './agent/index'
import type { SkillManager } from './agent/skills'
import type { SchedulerManager } from './agent/scheduler'
import type { SkillEvolutionManager } from './agent/skill-evolution'
import type { LocalModelManager } from './local-model/index'

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CLIOptions {
  command: string | null  // sub-command (first positional or flag-derived)
  prompt: string
  skills: string[]
  workspace: string | null
  permission: string
  model: string | null
  apiKey: string | null
  provider: string | null
  billingMode: string | null
  baseUrl: string | null
  // Named args for specific commands
  name: string | null
  description: string | null
  content: string | null
  filePath: string | null
  id: string | null
  timestamp: string | null
  keyword: string | null
  frequency: string | null
  taskPrompt: string | null
  enabled: boolean | null
  // Flags
  help: boolean
  version: boolean
  json: boolean
}

function parseArgs(argv: string[]): CLIOptions {
  const opts: CLIOptions = {
    command: null, prompt: '', skills: [], workspace: null,
    permission: 'accept-edit', model: null, apiKey: null, provider: null,
    billingMode: null, baseUrl: null, name: null, description: null,
    content: null, filePath: null, id: null, timestamp: null,
    keyword: null, frequency: null, taskPrompt: null, enabled: null,
    help: false, version: false, json: false,
  }

  const positional: string[] = []
  let i = 0

  while (i < argv.length) {
    const a = argv[i]
    const next = () => argv[++i]

    // Flags
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--version' || a === '-v') opts.version = true
    else if (a === '--json') opts.json = true
    // Config options
    else if (a === '--skill' && i + 1 < argv.length) opts.skills.push(next())
    else if (a === '--workspace' && i + 1 < argv.length) opts.workspace = next()
    else if (a === '--permission' && i + 1 < argv.length) opts.permission = next()
    else if (a === '--model' && i + 1 < argv.length) opts.model = next()
    else if (a === '--api-key' && i + 1 < argv.length) opts.apiKey = next()
    else if (a === '--provider' && i + 1 < argv.length) opts.provider = next()
    else if (a === '--billing-mode' && i + 1 < argv.length) opts.billingMode = next()
    else if (a === '--base-url' && i + 1 < argv.length) opts.baseUrl = next()
    // Named args for commands
    else if (a === '--name' && i + 1 < argv.length) opts.name = next()
    else if (a === '--description' && i + 1 < argv.length) opts.description = next()
    else if (a === '--content' && i + 1 < argv.length) opts.content = next()
    else if (a === '--file' && i + 1 < argv.length) opts.filePath = next()
    else if (a === '--id' && i + 1 < argv.length) opts.id = next()
    else if (a === '--timestamp' && i + 1 < argv.length) opts.timestamp = next()
    else if (a === '--keyword' && i + 1 < argv.length) opts.keyword = next()
    else if (a === '--frequency' && i + 1 < argv.length) opts.frequency = next()
    else if (a === '--task-prompt' && i + 1 < argv.length) opts.taskPrompt = next()
    else if (a === '--enable') opts.enabled = true
    else if (a === '--disable') opts.enabled = false
    else if (!a.startsWith('-')) positional.push(a)

    i++
  }

  // First positional is the command if it matches a known command name
  const commands = [
    'list-skills', 'toggle-skill', 'create-skill', 'delete-skill', 'import-skill',
    'skill-evolution', 'evolve-skill', 'apply-evolution', 'reject-evolution', 'rollback-skill',
    'list-tasks', 'run-task', 'create-task', 'delete-task', 'toggle-task',
    'list-sessions', 'search-sessions', 'delete-session',
    'list-models', 'model-status', 'download-model',
    'show-config', 'save-config',
  ]

  if (positional.length > 0 && commands.includes(positional[0])) {
    opts.command = positional.shift()!
    // Second positional is often the ID or name for the command
    if (positional.length > 0 && !opts.id && !opts.name) {
      opts.id = positional.shift()!
    }
  }

  opts.prompt = positional.join(' ')
  return opts
}

function printHelp() {
  console.log(`
${C.bold}Onit CLI${C.reset} — Desktop AI Agent

${C.bold}Agent:${C.reset}
  onit "prompt"                            Run an agent task
  onit --skill <name> "prompt"             Run with skill(s)
  onit --workspace <path> "prompt"         Set working directory
  onit --permission plan|accept-edit|full-access "prompt"

${C.bold}Skills:${C.reset}
  onit list-skills                         List all skills
  onit toggle-skill <name> --enable|--disable
  onit create-skill --name <n> --description <d> --content <c>
  onit delete-skill <name>
  onit import-skill --file <path>

${C.bold}Skill Evolution:${C.reset}
  onit skill-evolution <name>              View evolution data
  onit evolve-skill <name>                 Trigger evolution synthesis
  onit apply-evolution <name>              Apply pending evolution
  onit reject-evolution <name>             Reject pending evolution
  onit rollback-skill <name> --timestamp <ts>

${C.bold}Scheduled Tasks:${C.reset}
  onit list-tasks                          List scheduled tasks
  onit run-task <id>                       Execute a task now
  onit create-task --name <n> --task-prompt <p> --frequency <f>
  onit delete-task <id>
  onit toggle-task <id> --enable|--disable

${C.bold}Sessions:${C.reset}
  onit list-sessions                       List all sessions
  onit search-sessions --keyword <text>    Search session messages
  onit delete-session <id>

${C.bold}Local Models:${C.reset}
  onit list-models                         List available local models
  onit model-status                        Show current model status
  onit download-model <id>                 Download a model

${C.bold}Config:${C.reset}
  onit show-config                         Show current configuration
  onit save-config --api-key <k> --provider <p>  Save CLI config
  onit --help | --version

${C.bold}Global Options:${C.reset}
  --api-key <key>        API key (or ONIT_API_KEY env var)
  --model <model>        Model name
  --provider <name>      qianfan | volcengine | dashscope
  --billing-mode <mode>  coding-plan | api-call | local-model
  --base-url <url>       Custom API endpoint
  --json                 Output in JSON format
`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function promptYN(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes')
    })
  })
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString()
}

function out(data: any, json: boolean) {
  if (json) {
    console.log(JSON.stringify(data, null, 2))
  }
}

// ---------------------------------------------------------------------------
// CLI output handler for agent streaming
// ---------------------------------------------------------------------------

export function createCLIOutputHandler(agentManager: AgentManager): (channel: string, data: any) => void {
  let currentContent = ''

  return (channel: string, data: any) => {
    switch (channel) {
      case 'agent:stream': {
        const chunk = data.chunk
        if (!chunk) break
        if (chunk.type === 'content' && chunk.content) {
          process.stdout.write(chunk.content)
          currentContent += chunk.content
        } else if (chunk.type === 'thinking' && chunk.content) {
          process.stdout.write(`${C.dim}${chunk.content}${C.reset}`)
        } else if (chunk.type === 'tool-call-start' && chunk.toolCall) {
          const tc = chunk.toolCall
          const args = tc.arguments ? tc.arguments.substring(0, 120) : ''
          process.stdout.write(`\n${C.cyan}⚙ ${tc.name || 'tool'}${C.reset}${C.dim}(${args})${C.reset}\n`)
        } else if (chunk.type === 'tool-call-result' && chunk.toolCall) {
          const tc = chunk.toolCall
          if (tc.status === 'completed') {
            const preview = (tc.result || '').substring(0, 200)
            process.stdout.write(`${C.green}  ✓${C.reset} ${C.dim}${preview}${preview.length < (tc.result || '').length ? '...' : ''}${C.reset}\n`)
          } else if (tc.status === 'error') {
            process.stdout.write(`${C.red}  ✗ ${tc.error || 'Error'}${C.reset}\n`)
          }
        }
        break
      }
      case 'agent:complete': {
        if (currentContent) process.stdout.write('\n')
        const s = data.status
        if (s === 'completed') process.stderr.write(`${C.green}✅ Completed${C.reset}\n`)
        else if (s === 'stopped') process.stderr.write(`${C.yellow}⏹ Stopped${C.reset}\n`)
        break
      }
      case 'agent:error':
        process.stderr.write(`\n${C.red}❌ Error: ${data.error}${C.reset}\n`)
        break
      case 'agent:permission-request': {
        const req = data
        process.stdout.write(`\n${C.yellow}⚠ Permission: ${req.type || 'operation'}${C.reset}\n`)
        if (req.description) process.stdout.write(`  ${req.description}\n`)
        if (req.details) process.stdout.write(`  ${C.dim}${req.details.substring(0, 300)}${C.reset}\n`)
        promptYN(`  ${C.yellow}Allow? (y/n): ${C.reset}`).then(ok => {
          agentManager.handlePermissionResponse(req.id, ok)
        })
        break
      }
      default: break
    }
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  billingMode: string
  apiKey: string
  model: string
  customBaseUrl?: string
  codingPlanProvider?: string
  localModelId?: string
  maxInputTokens?: number
  maxOutputTokens?: number
}

function resolveConfig(opts: CLIOptions, settingsPath: string): ResolvedConfig | null {
  let saved: any = {}
  try {
    if (fs.existsSync(settingsPath)) {
      saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }
  } catch { /* ignore */ }

  const savedApi = saved.apiConfig || {}
  const billingMode = opts.billingMode || savedApi.billingMode || 'coding-plan'
  const apiKey = opts.apiKey || process.env.ONIT_API_KEY || savedApi.apiKey || ''
  const provider = opts.provider || savedApi.codingPlanProvider || 'qianfan'

  let model = opts.model || savedApi.model || ''
  if (!model && billingMode === 'coding-plan') {
    const m: Record<string, string> = { qianfan: 'qianfan-code-latest', volcengine: 'ark-code-latest', dashscope: 'qwen3.5-plus' }
    model = m[provider] || 'qianfan-code-latest'
  }

  if (billingMode !== 'local-model' && !apiKey) {
    process.stderr.write(`${C.red}Error: No API key.${C.reset} Set --api-key, ONIT_API_KEY, or run ${C.bold}onit save-config --api-key <key>${C.reset}\n`)
    return null
  }

  return {
    billingMode, apiKey, model,
    customBaseUrl: opts.baseUrl || savedApi.customBaseUrl,
    codingPlanProvider: provider,
    localModelId: savedApi.localModelId,
    maxInputTokens: savedApi.maxInputTokens || 95000,
    maxOutputTokens: savedApi.maxOutputTokens || 65000,
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface CLIDeps {
  agentManager: AgentManager
  skillManager: SkillManager
  skillEvolutionManager: SkillEvolutionManager
  schedulerManager: SchedulerManager
  localModelManager: LocalModelManager
  settingsPath: string
  sessionsDir: string
  artifactsDir: string
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runCLI(argv: string[], deps: CLIDeps): Promise<number> {
  const opts = parseArgs(argv)

  if (opts.help) { printHelp(); return 0 }
  if (opts.version) {
    try { console.log(`Onit v${require('../package.json').version}`) } catch { console.log('Onit') }
    return 0
  }

  const cmd = opts.command

  // =========================================================================
  // Skills
  // =========================================================================

  if (cmd === 'list-skills') {
    const skills = deps.skillManager.listSkills()
    if (opts.json) { out(skills, true); return 0 }
    if (skills.length === 0) { console.log('No skills found.'); return 0 }
    console.log(`${C.bold}Skills (${skills.length}):${C.reset}\n`)
    for (const s of skills) {
      const icon = s.enabled ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`
      const evo = s.evolvable ? `${C.cyan}⚡${C.reset}` : ''
      const mem = s.memory ? `${C.blue}🧠${C.reset}` : ''
      console.log(`  ${icon} ${C.bold}${s.displayName}${C.reset} ${C.dim}[${s.source}]${C.reset} ${evo}${mem}`)
      console.log(`    ${C.dim}@${s.name} — ${s.description}${C.reset}`)
      if (s.recordCount > 0) console.log(`    ${C.dim}${s.recordCount} records | Used ${s.usageCount}x${C.reset}`)
    }
    return 0
  }

  if (cmd === 'toggle-skill') {
    const name = opts.id
    if (!name) { process.stderr.write(`${C.red}Usage: onit toggle-skill <name> --enable|--disable${C.reset}\n`); return 1 }
    if (opts.enabled === null) { process.stderr.write(`${C.red}Specify --enable or --disable${C.reset}\n`); return 1 }
    const result = deps.skillManager.toggleSkill(name, opts.enabled)
    if (!result) { process.stderr.write(`${C.red}Skill not found: ${name}${C.reset}\n`); return 1 }
    console.log(`${opts.enabled ? C.green + '● Enabled' : C.dim + '○ Disabled'}${C.reset}: ${result.displayName}`)
    return 0
  }

  if (cmd === 'create-skill') {
    const name = opts.name || opts.id
    if (!name || !opts.description) {
      process.stderr.write(`${C.red}Usage: onit create-skill --name <n> --description <d> --content <c|--file path>${C.reset}\n`)
      return 1
    }
    let content = opts.content || ''
    if (opts.filePath) {
      try { content = fs.readFileSync(opts.filePath, 'utf-8') } catch (e: any) {
        process.stderr.write(`${C.red}Cannot read file: ${e.message}${C.reset}\n`); return 1
      }
    }
    const skill = deps.skillManager.createSkill(name, opts.description, content)
    if (opts.json) { out(skill, true); return 0 }
    console.log(`${C.green}✓ Created:${C.reset} ${skill.displayName} ${C.dim}(@${skill.name})${C.reset}`)
    return 0
  }

  if (cmd === 'delete-skill') {
    const name = opts.id
    if (!name) { process.stderr.write(`${C.red}Usage: onit delete-skill <name>${C.reset}\n`); return 1 }
    const ok = deps.skillManager.deleteSkill(name)
    if (!ok) { process.stderr.write(`${C.red}Cannot delete (not found or prebuilt): ${name}${C.reset}\n`); return 1 }
    console.log(`${C.green}✓ Deleted:${C.reset} ${name}`)
    return 0
  }

  if (cmd === 'import-skill') {
    const fp = opts.filePath || opts.id
    if (!fp) { process.stderr.write(`${C.red}Usage: onit import-skill --file <path>${C.reset}\n`); return 1 }
    if (!fs.existsSync(fp)) { process.stderr.write(`${C.red}File not found: ${fp}${C.reset}\n`); return 1 }
    try {
      const skill = deps.skillManager.importSkill(fp)
      if (!skill) { process.stderr.write(`${C.red}Failed to import: ${fp}${C.reset}\n`); return 1 }
      console.log(`${C.green}✓ Imported:${C.reset} ${skill.displayName}`)
    } catch (e: any) {
      process.stderr.write(`${C.red}Import error: ${e.message}${C.reset}\n`); return 1
    }
    return 0
  }

  // =========================================================================
  // Skill Evolution
  // =========================================================================

  if (cmd === 'skill-evolution') {
    const name = opts.id
    if (!name) { process.stderr.write(`${C.red}Usage: onit skill-evolution <skill-name>${C.reset}\n`); return 1 }
    const evo = deps.skillManager.getEvolutionData(name)
    if (opts.json) { out(evo, true); return 0 }

    console.log(`${C.bold}Skill Evolution: ${name}${C.reset}\n`)
    console.log(`  ${C.bold}Memory:${C.reset}`)
    if (evo.memory) {
      console.log(`  ${evo.memory.split('\n').join('\n  ')}`)
    } else {
      console.log(`  ${C.dim}(no memory yet)${C.reset}`)
    }

    console.log(`\n  ${C.bold}Records:${C.reset} ${evo.records.length}`)
    for (const r of evo.records.slice(-5)) {
      const date = formatDate(r.timestamp)
      const preview = r.conversation.substring(0, 80).replace(/\n/g, ' ')
      console.log(`    ${C.dim}${date}${C.reset} ${preview}${r.conversation.length > 80 ? '...' : ''}`)
    }

    if (evo.pendingEvolution) {
      console.log(`\n  ${C.yellow}⚡ Pending Evolution:${C.reset}`)
      console.log(`    ${evo.pendingEvolution.summary}`)
      console.log(`    ${C.dim}Proposed memory (${evo.pendingEvolution.proposedMemory.length} chars)${C.reset}`)
    }

    console.log(`\n  ${C.bold}History:${C.reset} ${evo.history.length} entries`)
    for (const h of evo.history.slice(-5)) {
      console.log(`    ${C.dim}${formatDate(h.timestamp)}${C.reset} — ${h.summary}`)
    }
    return 0
  }

  if (cmd === 'evolve-skill') {
    const name = opts.id
    if (!name) { process.stderr.write(`${C.red}Usage: onit evolve-skill <skill-name>${C.reset}\n`); return 1 }
    const config = resolveConfig(opts, deps.settingsPath)
    if (!config) return 1

    process.stderr.write(`${C.cyan}Analyzing usage records for ${name}...${C.reset}\n`)
    const result = await deps.skillEvolutionManager.synthesizeEvolution(name, config)

    if (!result.success) {
      process.stderr.write(`${C.yellow}${result.error}${C.reset}\n`)
      return 1
    }

    const evo = deps.skillManager.getEvolutionData(name)
    if (evo.pendingEvolution) {
      console.log(`\n${C.green}✓ Evolution proposed:${C.reset}`)
      console.log(`  ${evo.pendingEvolution.summary}`)
      console.log(`\n${C.bold}Proposed Memory:${C.reset}`)
      console.log(evo.pendingEvolution.proposedMemory)
      console.log(`\n${C.dim}Run ${C.bold}onit apply-evolution ${name}${C.reset}${C.dim} to apply, or ${C.bold}onit reject-evolution ${name}${C.reset}${C.dim} to reject.${C.reset}`)
    }
    return 0
  }

  if (cmd === 'apply-evolution') {
    const name = opts.id
    if (!name) { process.stderr.write(`${C.red}Usage: onit apply-evolution <skill-name>${C.reset}\n`); return 1 }
    const ok = await deps.skillEvolutionManager.applyEvolution(name)
    if (!ok) { process.stderr.write(`${C.red}No pending evolution for ${name}${C.reset}\n`); return 1 }
    console.log(`${C.green}✓ Evolution applied to ${name}${C.reset}`)
    return 0
  }

  if (cmd === 'reject-evolution') {
    const name = opts.id
    if (!name) { process.stderr.write(`${C.red}Usage: onit reject-evolution <skill-name>${C.reset}\n`); return 1 }
    const ok = await deps.skillEvolutionManager.rejectEvolution(name)
    if (!ok) { process.stderr.write(`${C.red}No pending evolution for ${name}${C.reset}\n`); return 1 }
    console.log(`${C.green}✓ Evolution rejected for ${name}${C.reset}`)
    return 0
  }

  if (cmd === 'rollback-skill') {
    const name = opts.id
    const ts = opts.timestamp
    if (!name || !ts) { process.stderr.write(`${C.red}Usage: onit rollback-skill <name> --timestamp <ts>${C.reset}\n`); return 1 }
    const ok = await deps.skillEvolutionManager.rollback(name, ts)
    if (!ok) { process.stderr.write(`${C.red}Rollback failed for ${name}${C.reset}\n`); return 1 }
    console.log(`${C.green}✓ Rolled back ${name} to before ${formatDate(Number(ts))}${C.reset}`)
    return 0
  }

  // =========================================================================
  // Scheduled Tasks
  // =========================================================================

  if (cmd === 'list-tasks') {
    const tasks = deps.schedulerManager.listTasks()
    if (opts.json) { out(tasks, true); return 0 }
    if (tasks.length === 0) { console.log('No scheduled tasks.'); return 0 }
    console.log(`${C.bold}Scheduled Tasks (${tasks.length}):${C.reset}\n`)
    for (const t of tasks) {
      const icon = t.enabled ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`
      console.log(`  ${icon} ${C.bold}${t.name}${C.reset} ${C.dim}[${t.id}]${C.reset}`)
      console.log(`    ${C.dim}${t.frequency}${t.lastRun ? ` | Last: ${formatDate(t.lastRun)}` : ''}${C.reset}`)
      if (t.taskPrompt) console.log(`    ${C.dim}${t.taskPrompt.substring(0, 80)}${C.reset}`)
    }
    return 0
  }

  if (cmd === 'run-task') {
    const id = opts.id
    if (!id) { process.stderr.write(`${C.red}Usage: onit run-task <task-id>${C.reset}\n`); return 1 }
    const config = resolveConfig(opts, deps.settingsPath)
    if (!config) return 1
    deps.schedulerManager.setApiConfig(config)

    process.stderr.write(`${C.cyan}Running task: ${id}${C.reset}\n\n`)
    const result = await deps.schedulerManager.runTaskNow(id, { triggerSource: 'manual' })
    if (!result) { process.stderr.write(`${C.red}Failed. Check task ID and config.${C.reset}\n`); return 1 }
    await waitForAgent(deps.agentManager, `scheduled-${id}`)
    return 0
  }

  if (cmd === 'create-task') {
    const name = opts.name
    const taskPrompt = opts.taskPrompt
    if (!name || !taskPrompt) {
      process.stderr.write(`${C.red}Usage: onit create-task --name <n> --task-prompt <p> [--frequency daily] [--workspace <path>]${C.reset}\n`)
      return 1
    }
    const task = deps.schedulerManager.createTask({
      name,
      description: opts.description || '',
      taskPrompt,
      model: opts.model || 'qianfan-code-latest',
      workspacePath: opts.workspace,
      frequency: opts.frequency || 'manual',
      enabled: true,
    })
    if (opts.json) { out(task, true); return 0 }
    console.log(`${C.green}✓ Created:${C.reset} ${task.name} ${C.dim}[${task.id}]${C.reset}`)
    return 0
  }

  if (cmd === 'delete-task') {
    const id = opts.id
    if (!id) { process.stderr.write(`${C.red}Usage: onit delete-task <id>${C.reset}\n`); return 1 }
    const ok = deps.schedulerManager.deleteTask(id)
    if (!ok) { process.stderr.write(`${C.red}Task not found: ${id}${C.reset}\n`); return 1 }
    console.log(`${C.green}✓ Deleted task: ${id}${C.reset}`)
    return 0
  }

  if (cmd === 'toggle-task') {
    const id = opts.id
    if (!id || opts.enabled === null) {
      process.stderr.write(`${C.red}Usage: onit toggle-task <id> --enable|--disable${C.reset}\n`); return 1
    }
    const result = deps.schedulerManager.toggleTask(id, opts.enabled)
    if (!result) { process.stderr.write(`${C.red}Task not found: ${id}${C.reset}\n`); return 1 }
    console.log(`${opts.enabled ? C.green + '● Enabled' : C.dim + '○ Disabled'}${C.reset}: ${result.name}`)
    return 0
  }

  // =========================================================================
  // Sessions
  // =========================================================================

  if (cmd === 'list-sessions') {
    const sessions = loadSessions(deps.sessionsDir)
    if (opts.json) { out(sessions, true); return 0 }
    if (sessions.length === 0) { console.log('No sessions.'); return 0 }
    console.log(`${C.bold}Sessions (${sessions.length}):${C.reset}\n`)
    for (const s of sessions.slice(0, 20)) {
      const msgCount = s.messages?.length || 0
      const status = s.status === 'running' ? `${C.cyan}●${C.reset}` : `${C.dim}○${C.reset}`
      console.log(`  ${status} ${C.bold}${s.name}${C.reset} ${C.dim}[${s.id}]${C.reset}`)
      console.log(`    ${C.dim}${msgCount} messages | ${formatDate(s.updatedAt || s.createdAt)}${C.reset}`)
    }
    if (sessions.length > 20) console.log(`  ${C.dim}...and ${sessions.length - 20} more${C.reset}`)
    return 0
  }

  if (cmd === 'search-sessions') {
    const keyword = opts.keyword || opts.id || opts.prompt
    if (!keyword) { process.stderr.write(`${C.red}Usage: onit search-sessions --keyword <text>${C.reset}\n`); return 1 }
    const sessions = loadSessions(deps.sessionsDir)
    const results: { session: any; matches: string[] }[] = []

    for (const s of sessions) {
      const matches: string[] = []
      for (const m of s.messages || []) {
        if (m.content && m.content.toLowerCase().includes(keyword.toLowerCase())) {
          matches.push(`[${m.role}] ${m.content.substring(0, 120)}`)
        }
      }
      if (matches.length > 0) results.push({ session: s, matches })
    }

    if (opts.json) { out(results, true); return 0 }
    if (results.length === 0) { console.log(`No results for "${keyword}".`); return 0 }
    console.log(`${C.bold}Search results for "${keyword}" (${results.length} sessions):${C.reset}\n`)
    for (const r of results.slice(0, 10)) {
      console.log(`  ${C.bold}${r.session.name}${C.reset} ${C.dim}[${r.session.id}]${C.reset}`)
      for (const m of r.matches.slice(0, 3)) {
        console.log(`    ${C.dim}${m}${C.reset}`)
      }
      if (r.matches.length > 3) console.log(`    ${C.dim}...${r.matches.length - 3} more matches${C.reset}`)
    }
    return 0
  }

  if (cmd === 'delete-session') {
    const id = opts.id
    if (!id) { process.stderr.write(`${C.red}Usage: onit delete-session <id>${C.reset}\n`); return 1 }
    const fp = path.join(deps.sessionsDir, `${id}.json`)
    if (!fs.existsSync(fp)) { process.stderr.write(`${C.red}Session not found: ${id}${C.reset}\n`); return 1 }
    fs.unlinkSync(fp)
    console.log(`${C.green}✓ Deleted session: ${id}${C.reset}`)
    return 0
  }

  // =========================================================================
  // Local Models
  // =========================================================================

  if (cmd === 'list-models') {
    const modelIds = ['qwen3.5-4b', 'qwen3.5-0.8b']
    const results = []
    console.log(`${C.bold}Available Local Models:${C.reset}\n`)
    for (const id of modelIds) {
      const status = await deps.localModelManager.checkModelStatus(id)
      results.push({ id, ...status })
      const icon = status.status === 'ready' ? `${C.green}●${C.reset}`
        : status.status === 'downloaded' ? `${C.blue}◉${C.reset}`
        : `${C.dim}○${C.reset}`
      console.log(`  ${icon} ${C.bold}${id}${C.reset} — ${C.dim}${status.status}${C.reset}`)
    }
    if (opts.json) { out(results, true) }
    return 0
  }

  if (cmd === 'model-status') {
    const modelId = opts.id
    if (modelId) {
      const status = await deps.localModelManager.checkModelStatus(modelId)
      if (opts.json) { out(status, true); return 0 }
      console.log(`${C.bold}Model:${C.reset} ${modelId}`)
      console.log(`${C.bold}Status:${C.reset} ${status.status}`)
      if (status.error) console.log(`${C.red}Error:${C.reset} ${status.error}`)
    } else {
      const modelIds = ['qwen3.5-4b', 'qwen3.5-0.8b']
      for (const id of modelIds) {
        const status = await deps.localModelManager.checkModelStatus(id)
        console.log(`  ${id}: ${status.status}`)
      }
    }
    return 0
  }

  if (cmd === 'download-model') {
    const modelId = opts.id
    if (!modelId) { process.stderr.write(`${C.red}Usage: onit download-model <model-id>${C.reset}\n`); return 1 }
    process.stderr.write(`${C.cyan}Downloading ${modelId}...${C.reset}\n`)
    try {
      await deps.localModelManager.downloadModel(modelId, (progress: number) => {
        process.stderr.write(`\r${C.dim}Progress: ${progress}%${C.reset}`)
      })
      process.stderr.write(`\n${C.green}✓ Download complete${C.reset}\n`)
      return 0
    } catch (e: any) {
      process.stderr.write(`\n${C.red}Download failed: ${e.message}${C.reset}\n`)
      return 1
    }
  }

  // =========================================================================
  // Config
  // =========================================================================

  if (cmd === 'show-config') {
    let saved: any = {}
    try { saved = JSON.parse(fs.readFileSync(deps.settingsPath, 'utf-8')) } catch {}
    if (opts.json) { out(saved, true); return 0 }
    console.log(`${C.bold}CLI Config:${C.reset} ${deps.settingsPath}\n`)
    const api = saved.apiConfig || {}
    console.log(`  billingMode:  ${api.billingMode || C.dim + '(not set)' + C.reset}`)
    console.log(`  apiKey:       ${api.apiKey ? '***' + api.apiKey.slice(-4) : C.dim + '(not set)' + C.reset}`)
    console.log(`  model:        ${api.model || C.dim + '(not set)' + C.reset}`)
    console.log(`  provider:     ${api.codingPlanProvider || C.dim + '(not set)' + C.reset}`)
    console.log(`  baseUrl:      ${api.customBaseUrl || C.dim + '(not set)' + C.reset}`)
    console.log(`  localModelId: ${api.localModelId || C.dim + '(not set)' + C.reset}`)
    return 0
  }

  if (cmd === 'save-config') {
    const config = resolveConfig(opts, deps.settingsPath)
    if (!config && !opts.apiKey) {
      process.stderr.write(`${C.red}Provide at least --api-key${C.reset}\n`); return 1
    }
    const toSave = { apiConfig: config || { billingMode: 'coding-plan', apiKey: opts.apiKey } }
    fs.writeFileSync(deps.settingsPath, JSON.stringify(toSave, null, 2), 'utf-8')
    console.log(`${C.green}✓ Config saved to ${deps.settingsPath}${C.reset}`)
    return 0
  }

  // =========================================================================
  // Default: run agent with prompt
  // =========================================================================

  if (!opts.prompt) {
    process.stderr.write(`${C.red}No command or prompt.${C.reset} Run ${C.bold}onit --help${C.reset}\n`)
    return 1
  }

  const config = resolveConfig(opts, deps.settingsPath)
  if (!config) return 1

  let message = opts.prompt
  if (opts.skills.length > 0) {
    message = opts.skills.map(s => `@${s}`).join(' ') + ' ' + message
  }

  const enabledSkills = deps.skillManager.getEnabledSkills().map(s => ({
    name: s.name, displayName: s.displayName, description: s.description,
    content: s.content, memory: s.memory,
  }))

  const sessionId = `cli-${Date.now()}`
  const runId = `${sessionId}-run`

  process.stderr.write(`${C.dim}Session: ${sessionId} | Model: ${config.model} (${config.billingMode})${C.reset}\n`)
  if (opts.workspace) process.stderr.write(`${C.dim}Workspace: ${opts.workspace}${C.reset}\n`)
  if (opts.skills.length > 0) process.stderr.write(`${C.dim}Skills: ${opts.skills.join(', ')}${C.reset}\n`)
  process.stderr.write('\n')

  const started = await deps.agentManager.startAgent(sessionId, message, runId, {
    permissionMode: opts.permission, workspacePath: opts.workspace,
    model: config.model, messages: [], apiConfig: config, enabledSkills,
  })

  if (!started) { process.stderr.write(`${C.red}Failed to start agent.${C.reset}\n`); return 1 }
  await waitForAgent(deps.agentManager, sessionId)
  return 0
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForAgent(mgr: AgentManager, prefix: string): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      if (!mgr.getRunningSessionIds().some(id => id.startsWith(prefix))) resolve()
      else setTimeout(check, 200)
    }
    setTimeout(check, 500)
  })
}

function loadSessions(dir: string): any[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) } catch { return null } })
    .filter(Boolean)
    .sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export function detectCLIMode(isPackaged: boolean): string[] | null {
  const argv = process.argv.slice(isPackaged ? 1 : 2)
  const userArgs = argv.filter(a =>
    !a.startsWith('--inspect') && !a.startsWith('--remote-debugging') &&
    !a.startsWith('--type=') && !a.startsWith('--no-sandbox') &&
    !a.startsWith('--enable-') && !a.startsWith('--disable-') &&
    !a.startsWith('--force-') && !a.startsWith('--gpu') &&
    a !== '.' && a !== '--'
  )
  return userArgs.length > 0 ? userArgs : null
}
