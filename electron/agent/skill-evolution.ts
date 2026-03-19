import https from 'https'
import http from 'http'
import { URL } from 'url'
import { v4 as uuidv4 } from 'uuid'
import type { SkillManager, SkillData, EvolutionData, UsageRecord, PendingEvolution } from './skills'
import type { AgentMessage } from './types'

/** Max characters for the conversation log in a single UsageRecord. */
const RECORD_CONVERSATION_MAX_CHARS = 8000
/** Max characters for a single message entry in the conversation log. */
const RECORD_ENTRY_MAX_CHARS = 500
/** Max total characters for all records' conversation logs combined (triggers compression). */
const RECORDS_TOTAL_STORAGE_BUDGET = 40000

interface ApiConfig {
  billingMode: string
  apiKey: string
  model?: string
  customBaseUrl?: string
  codingPlanProvider?: string
  localModelId?: string
  maxInputTokens?: number
  maxOutputTokens?: number
}

interface SynthesizeResult {
  success: boolean
  error?: string
}

/** Minimum new records since last analysis to trigger auto-analysis. */
const AUTO_ANALYZE_RECORD_THRESHOLD = 3
/** Minimum cooldown between auto-analyses per skill (24 hours). */
const AUTO_ANALYZE_COOLDOWN_MS = 24 * 60 * 60 * 1000

export class SkillEvolutionManager {
  private skillManager: SkillManager
  /** Guard: only one auto-analysis at a time across all skills. */
  private autoAnalyzing = false

  constructor(skillManager: SkillManager) {
    this.skillManager = skillManager
  }

  // ---------------------------------------------------------------------------
  // Recording — called after each agent run
  // ---------------------------------------------------------------------------

  /**
   * Save or update a UsageRecord for a skill in the given session.
   * Builds a formatted conversation log (user messages + tool call summaries +
   * agent response summaries) and writes to EVOLUTION.json.
   * One record per skill per session; subsequent runs update the existing record.
   *
   * If total storage exceeds budget, compresses the oldest records via LLM.
   */
  async recordUsage(
    skillId: string,
    sessionId: string,
    messages: AgentMessage[],
    apiConfig?: ApiConfig,
  ): Promise<void> {
    const skill = this.skillManager.listSkills().find(s => s.id === skillId)
    if (!skill || !skill.evolvable) return

    // Build conversation log and context
    const { conversation, context } = this.buildConversationLog(messages)
    if (!conversation) return

    const evoData = this.skillManager.getEvolutionData(skillId)

    // Upsert: one record per session
    const existingIdx = evoData.records.findIndex(r => r.sessionId === sessionId)
    if (existingIdx >= 0) {
      evoData.records[existingIdx].conversation = conversation
      evoData.records[existingIdx].context = context
      evoData.records[existingIdx].lastUpdatedAt = Date.now()
    } else {
      evoData.records.push({
        id: uuidv4(),
        sessionId,
        timestamp: Date.now(),
        lastUpdatedAt: Date.now(),
        conversation,
        context,
      })
    }

    await this.skillManager.saveEvolutionData(skillId, evoData)

    // Check if total storage exceeds budget → compress oldest uncompressed records
    const totalChars = evoData.records.reduce((sum, r) => sum + r.conversation.length, 0)
    if (totalChars > RECORDS_TOTAL_STORAGE_BUDGET && apiConfig && apiConfig.billingMode !== 'local-model') {
      await this.compressOldRecords(skillId, evoData, apiConfig)
    }

    // Auto-trigger background analysis when enough new records accumulate
    if (apiConfig && apiConfig.billingMode !== 'local-model') {
      this.maybeAutoAnalyze(skillId, evoData, apiConfig)
    }
  }

  // ---------------------------------------------------------------------------
  // Reflect — user-triggered synthesis (1 LLM call)
  // ---------------------------------------------------------------------------

  /**
   * Analyze all accumulated usage records and propose an updated skill memory.
   * One LLM call that reads current memory + records → outputs a complete new memory.
   */
  async synthesizeEvolution(skillId: string, apiConfig: ApiConfig): Promise<SynthesizeResult> {
    if (apiConfig.billingMode === 'local-model') {
      return { success: false, error: 'Evolution synthesis requires a cloud model' }
    }

    const skill = this.skillManager.listSkills().find(s => s.id === skillId)
    if (!skill) return { success: false, error: 'Skill not found' }
    if (!skill.evolvable) return { success: false, error: 'Skill is not evolvable' }

    const evoData = this.skillManager.getEvolutionData(skillId)
    if (evoData.records.length === 0) {
      return { success: false, error: '还没有使用记录。多使用几次这个 Skill 后再来进化。' }
    }
    if (evoData.pendingEvolution) {
      return { success: false, error: '已有一个待审核的进化方案，请先处理。' }
    }

    try {
      const pending = await this.doSynthesize(skill, evoData, apiConfig)
      if (!pending) {
        // LLM analyzed but found nothing useful — update lastAutoAnalyzedAt so we don't
        // re-trigger until enough new records accumulate
        evoData.lastAutoAnalyzedAt = Date.now()
        await this.skillManager.saveEvolutionData(skillId, evoData)
        return { success: false, error: '分析了使用记录，暂未发现有置信度的可学习信息。继续使用，积累更多有效反馈后再试。' }
      }

      evoData.pendingEvolution = pending
      evoData.lastAutoAnalyzedAt = Date.now()
      await this.skillManager.saveEvolutionData(skillId, evoData)
      return { success: true }
    } catch (err: any) {
      console.error(`[SkillEvolution] Synthesis failed for ${skillId}:`, err)
      return { success: false, error: err?.message || 'Unknown error' }
    }
  }

  // ---------------------------------------------------------------------------
  // Apply / Reject / Rollback
  // ---------------------------------------------------------------------------

  /**
   * Apply the pending evolution: replace memory with proposed memory,
   * record history snapshot, consume used records. SKILL.md is never modified.
   */
  async applyEvolution(skillId: string): Promise<boolean> {
    const evoData = this.skillManager.getEvolutionData(skillId)
    if (!evoData.pendingEvolution) return false

    const pending = evoData.pendingEvolution

    // Replace memory with proposed memory
    evoData.memory = pending.proposedMemory

    // Record history (stores full memory snapshot for rollback)
    evoData.history.push({
      timestamp: Date.now(),
      memorySnapshot: pending.proposedMemory,
      recordIds: pending.recordsUsed,
      summary: pending.summary,
    })

    // Consume used records
    const consumedIds = new Set(pending.recordsUsed)
    evoData.records = evoData.records.filter(r => !consumedIds.has(r.id))

    // Clear pending
    evoData.pendingEvolution = null

    await this.skillManager.saveEvolutionData(skillId, evoData)
    return true
  }

  /** Reject the pending evolution without applying. Records are preserved. */
  async rejectEvolution(skillId: string): Promise<boolean> {
    const evoData = this.skillManager.getEvolutionData(skillId)
    if (!evoData.pendingEvolution) return false

    evoData.pendingEvolution = null
    await this.skillManager.saveEvolutionData(skillId, evoData)
    return true
  }

  /**
   * Roll back to a point in history identified by timestamp string.
   * Restores the memory snapshot from the entry BEFORE the target.
   * If rolling back to the first entry, memory is cleared to null.
   */
  async rollback(skillId: string, targetTimestamp: string): Promise<boolean> {
    const evoData = this.skillManager.getEvolutionData(skillId)
    const ts = Number(targetTimestamp)
    if (isNaN(ts)) return false

    const entryIdx = evoData.history.findIndex(h => h.timestamp === ts)
    if (entryIdx < 0) return false

    // Restore memory to the state before the target entry
    if (entryIdx === 0) {
      // Rolling back the first evolution → no memory existed before
      evoData.memory = null
    } else {
      // Restore the snapshot from the entry just before the target
      evoData.memory = evoData.history[entryIdx - 1].memorySnapshot
    }

    // Trim history
    evoData.history = evoData.history.slice(0, entryIdx)
    evoData.pendingEvolution = null

    await this.skillManager.saveEvolutionData(skillId, evoData)
    return true
  }

  // ---------------------------------------------------------------------------
  // Private: Auto-analysis trigger
  // ---------------------------------------------------------------------------

  /**
   * Check if enough new records have accumulated since last analysis.
   * If so, run synthesis in the background (fire-and-forget).
   * The result becomes a pendingEvolution that the UI shows as a badge.
   */
  private maybeAutoAnalyze(skillId: string, evoData: EvolutionData, apiConfig: ApiConfig): void {
    // Don't auto-analyze if there's already a pending evolution
    if (evoData.pendingEvolution) return
    // Don't run multiple auto-analyses concurrently
    if (this.autoAnalyzing) return
    // Cooldown: at most one auto-analysis per skill per cooldown period
    const since = evoData.lastAutoAnalyzedAt || 0
    if (Date.now() - since < AUTO_ANALYZE_COOLDOWN_MS) return
    const newRecords = evoData.records.filter(r => r.lastUpdatedAt > since)
    if (newRecords.length < AUTO_ANALYZE_RECORD_THRESHOLD) return

    // Fire-and-forget: run synthesis in background
    this.autoAnalyzing = true
    this.synthesizeEvolution(skillId, apiConfig)
      .then((result) => {
        if (result.success) {
          console.log(`[SkillEvolution] Auto-analysis found improvements for ${skillId}`)
        }
      })
      .catch(() => { /* silent */ })
      .finally(() => {
        this.autoAnalyzing = false
      })
  }

  // ---------------------------------------------------------------------------
  // Private: Conversation logging & compression
  // ---------------------------------------------------------------------------

  /**
   * Build a formatted conversation log from agent messages.
   * Includes user messages, tool call summaries, and agent response summaries.
   */
  private buildConversationLog(messages: AgentMessage[]): {
    conversation: string | null
    context: { toolsUsed?: string[]; iterationCount?: number }
  } {
    const toolsUsed = new Set<string>()
    let iterationCount = 0

    // First pass: build ALL entries with per-entry truncation
    const allEntries: string[] = []
    for (const msg of messages) {
      if (msg.role === 'user' && msg.content) {
        // User messages are the most valuable — generous limit
        allEntries.push(`[User]: ${msg.content.substring(0, RECORD_ENTRY_MAX_CHARS)}`)

      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          iterationCount++
          for (const tc of msg.tool_calls) {
            toolsUsed.add(tc.function.name)
            let argSummary = ''
            try {
              const args = JSON.parse(tc.function.arguments)
              const keys = Object.keys(args)
              if (keys.length > 0) {
                argSummary = keys.map(k => {
                  const v = String(args[k])
                  return `${k}=${v.length > 60 ? v.substring(0, 60) + '...' : v}`
                }).join(', ')
              }
            } catch { /* ignore parse errors */ }
            allEntries.push(`[Tool]: ${tc.function.name}(${argSummary.substring(0, 120)})`)
          }
        }
        if (msg.content) {
          const preview = msg.content.substring(0, 500)
          allEntries.push(`[Agent]: ${preview}${msg.content.length > 500 ? '...' : ''}`)
        }

      } else if (msg.role === 'tool' && msg.content) {
        const preview = msg.content.substring(0, 300)
        allEntries.push(`[Result]: ${preview}${msg.content.length > 300 ? '...' : ''}`)
      }
    }

    if (allEntries.length === 0) return { conversation: null, context: {} }

    // Second pass: if total exceeds budget, keep beginning + end (drop middle)
    // This ensures the initial request AND final user feedback are always captured.
    const fullLog = allEntries.join('\n')
    let conversation: string

    if (fullLog.length <= RECORD_CONVERSATION_MAX_CHARS) {
      conversation = fullLog
    } else {
      // Reserve space: 30% beginning (initial request + early context), 70% end (recent activity + feedback)
      const headBudget = Math.floor(RECORD_CONVERSATION_MAX_CHARS * 0.3)
      const tailBudget = RECORD_CONVERSATION_MAX_CHARS - headBudget - 30 // 30 for separator

      // Build head from start
      let headEnd = 0
      let headChars = 0
      for (let i = 0; i < allEntries.length; i++) {
        const entryLen = allEntries[i].length + 1 // +1 for newline
        if (headChars + entryLen > headBudget) break
        headChars += entryLen
        headEnd = i + 1
      }

      // Build tail from end
      let tailStart = allEntries.length
      let tailChars = 0
      for (let i = allEntries.length - 1; i >= headEnd; i--) {
        const entryLen = allEntries[i].length + 1
        if (tailChars + entryLen > tailBudget) break
        tailChars += entryLen
        tailStart = i
      }

      const head = allEntries.slice(0, headEnd).join('\n')
      const tail = allEntries.slice(tailStart).join('\n')
      const skipped = tailStart - headEnd
      conversation = `${head}\n\n[... ${skipped} entries omitted ...]\n\n${tail}`
    }

    return {
      conversation,
      context: {
        toolsUsed: toolsUsed.size > 0 ? [...toolsUsed] : undefined,
        iterationCount: iterationCount || undefined,
      },
    }
  }

  /**
   * Compress the oldest uncompressed records via LLM summarization.
   * Keeps the most recent records intact, compresses older ones.
   */
  private async compressOldRecords(
    skillId: string,
    evoData: EvolutionData,
    apiConfig: ApiConfig,
  ): Promise<void> {
    // Sort by timestamp, compress oldest uncompressed records
    const uncompressed = evoData.records
      .filter(r => !r.compressed)
      .sort((a, b) => a.timestamp - b.timestamp)

    // Keep the 5 most recent uncompressed, compress the rest
    const toCompress = uncompressed.slice(0, Math.max(0, uncompressed.length - 5))
    if (toCompress.length === 0) return

    for (const record of toCompress) {
      try {
        const summary = await this.sideChannelCompletion(apiConfig, [
          { role: 'user', content: `Summarize the key user feedback and preferences from this conversation log in 2-3 sentences. Focus ONLY on what would help improve the skill's behavior. If there is no useful feedback, say "No actionable feedback."\n\n${record.conversation}` },
        ], { maxTokens: 300, temperature: 0.2 })

        if (summary) {
          record.conversation = `[Compressed summary]: ${summary.trim()}`
          record.compressed = true
        }
      } catch {
        // Compression failed — leave the record as-is
      }
    }

    await this.skillManager.saveEvolutionData(skillId, evoData)
  }

  // ---------------------------------------------------------------------------
  // Private: Reflect synthesis
  // ---------------------------------------------------------------------------

  private async doSynthesize(
    skill: SkillData,
    evoData: EvolutionData,
    apiConfig: ApiConfig,
  ): Promise<PendingEvolution | null> {
    // Build the records section — include all records in chronological order
    const sorted = [...evoData.records].sort((a, b) => a.timestamp - b.timestamp)
    const recordIds = sorted.map(r => r.id)

    const recordsSection = sorted.map(record => {
      const dateStr = new Date(record.timestamp).toISOString().split('T')[0]
      const ctxParts: string[] = []
      if (record.context?.iterationCount) ctxParts.push(`${record.context.iterationCount} iterations`)
      if (record.context?.toolsUsed?.length) ctxParts.push(`tools: ${record.context.toolsUsed.join(', ')}`)
      const ctxLine = ctxParts.length > 0 ? ` | ${ctxParts.join(' | ')}` : ''
      return `Record (${dateStr}${ctxLine}):\n${record.conversation}`
    }).join('\n\n')

    if (recordIds.length === 0) return null
    const previousMemory = evoData.memory || ''

    const currentMemorySection = evoData.memory
      ? `\nCurrent Skill Memory:\n\`\`\`\n${evoData.memory}\n\`\`\`\n`
      : '\nThis skill has no memory yet.\n'

    const hintsSection = skill.evolutionHints?.length
      ? `\nThe skill author has indicated these areas are worth learning about:\n${skill.evolutionHints.map(h => `- ${h}`).join('\n')}\n`
      : ''

    const prompt = `You are updating the Skill Memory for an AI agent's skill based on real usage data.

**How Skill Memory works**: At runtime, when the agent uses this skill, it sees the skill's base prompt followed by a "## Skill Memory" section. The memory becomes part of the agent's working context — it reads and follows it just like the base prompt. So write the memory as knowledge and instructions the agent can directly act on, not as an analysis report.

## Current Skill

Name: ${skill.displayName}
Description: ${skill.description}

Base prompt:
\`\`\`
${skill.content}
\`\`\`
${currentMemorySection}${hintsSection}
## Usage Records

Full conversation logs from sessions where this skill was used (including user messages, tool calls, tool results, and agent responses):

${recordsSection}

## Your Task

Analyze ALL dimensions of the usage records and produce an updated Skill Memory. Look at the complete picture — not just what the user said, but how the agent worked, what tools it used, what succeeded, what failed, and what the user corrected.

### What to look for (not limited to these — use your judgment):
- **User preferences & instructions**: Output language, format, style, detail level. Explicit directives ("以后都要...", "always...") and patterns from corrections.
- **Effective workflows**: Tool call sequences or approaches that led to good results. Approaches the user confirmed or didn't need to correct.
- **Failures & inefficiencies**: Tool calls that errored, unnecessary steps, wrong approaches — and the correct alternative.
- **Domain context**: Knowledge about the user's tech stack, project structure, coding conventions, or environment that makes the skill more effective.
- **Conditional behavior**: Different situations requiring different approaches (e.g., Python vs JavaScript, small files vs large codebases).

### Quality Principles

1. **Actionable** — Write each item as something the agent can directly follow at runtime.
   - Good: "Always respond in Chinese when the user writes in Chinese"
   - Bad: "The user seems to prefer Chinese" (vague, not actionable)

2. **Evidence-based** — Every item must trace back to evidence in the usage records. Don't speculate.

3. **Durable** — Capture knowledge that applies across future sessions, not one-time facts.
   - Good: "This user's project uses TypeScript + React with Tailwind CSS"
   - Bad: "The user was editing src/components/Header.tsx" (too specific to one session)

4. **Non-redundant** — Don't repeat what the skill's base prompt already covers. Only add knowledge that goes beyond or refines the base instructions.

5. **Evidence threshold** — A single explicit instruction from the user is sufficient. But implicit patterns (user seemed to prefer X without saying so) need 2+ occurrences across different sessions.

6. **Stable vs volatile** — Distinguish between stable knowledge (user preferences, coding conventions, project tech stack) and volatile knowledge (environment state, tool availability, network conditions, external service status). For volatile observations, use soft language ("prefer X", "X has worked better", "Y has had connectivity issues") rather than absolute statements ("never use Y", "Y is unavailable"). Conditions may change — the memory should guide the agent's choices without blocking alternatives.

### Updating existing memory

If there is existing Skill Memory, produce a **complete updated version** (not a diff):
- Keep items that remain valid
- Update items that have newer/better evidence
- Remove items that are contradicted by newer records
- Add newly discovered items

### Output — respond with ONLY valid JSON (no markdown fences):
{
  "memory": "the full updated memory in markdown format",
  "summary": "1-2 sentences explaining what changed and why",
  "hasChanges": true
}

If the records contain no useful signal:
{ "memory": "", "summary": "No actionable patterns found.", "hasChanges": false }`

    const result = await this.sideChannelCompletion(apiConfig, [
      { role: 'user', content: prompt },
    ], { maxTokens: 2000, temperature: 0.3 })

    if (!result) return null

    const parsed = this.parseJsonResponse<{
      memory: string
      summary: string
      hasChanges: boolean
    }>(result)

    if (!parsed || !parsed.summary) return null

    // If LLM says no changes, return null
    if (!parsed.hasChanges || !parsed.memory || parsed.memory.trim().length === 0) return null

    return {
      proposedMemory: parsed.memory.trim(),
      previousMemory,
      summary: parsed.summary,
      recordsUsed: recordIds,
      generatedAt: Date.now(),
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Helpers
  // ---------------------------------------------------------------------------

  private parseJsonResponse<T>(text: string): T | null {
    try {
      // Strip markdown code fences if present
      const cleaned = text.replace(/^```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '').trim()
      return JSON.parse(cleaned) as T
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Side-channel LLM call (independent of AgentSession)
  // ---------------------------------------------------------------------------

  private async sideChannelCompletion(
    apiConfig: ApiConfig,
    messages: { role: string; content: string }[],
    options: { maxTokens?: number; temperature?: number } = {},
  ): Promise<string | null> {
    const url = this.getApiUrl(apiConfig)
    const model = this.getModel(apiConfig)

    const body = JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2000,
    })

    return new Promise((resolve) => {
      const parsedUrl = new URL(url)
      const isHttps = parsedUrl.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const req = httpModule.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.apiKey}`,
          },
          timeout: 60000,
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: Buffer) => { data += chunk.toString() })
          res.on('end', () => {
            try {
              const json = JSON.parse(data)
              const content = json.choices?.[0]?.message?.content
              resolve(content || null)
            } catch {
              resolve(null)
            }
          })
        },
      )

      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.write(body)
      req.end()
    })
  }

  /** Resolve API URL — same logic as the main agent in agent/index.ts. */
  private getApiUrl(apiConfig: ApiConfig): string {
    if (apiConfig.customBaseUrl) return apiConfig.customBaseUrl
    if (apiConfig.billingMode === 'coding-plan') {
      const urls: Record<string, string> = {
        qianfan: 'https://qianfan.baidubce.com/v2/coding/chat/completions',
        volcengine: 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
        dashscope: 'https://coding.dashscope.aliyuncs.com/v1/chat/completions',
      }
      return urls[apiConfig.codingPlanProvider || 'qianfan'] || urls.qianfan
    }
    return 'https://qianfan.baidubce.com/v2/chat/completions'
  }

  /** Resolve model — uses the same model the user configured for the agent. */
  private getModel(apiConfig: ApiConfig): string {
    if (apiConfig.billingMode === 'coding-plan') {
      const models: Record<string, string> = {
        qianfan: 'qianfan-code-latest',
        volcengine: 'ark-code-latest',
        dashscope: 'qwen3.5-plus',
      }
      return models[apiConfig.codingPlanProvider || 'qianfan'] || models.qianfan
    }
    // API Call mode — use the model the user selected
    return apiConfig.model!
  }
}
