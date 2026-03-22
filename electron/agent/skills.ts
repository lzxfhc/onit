import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

export interface SkillData {
  id: string
  name: string
  displayName: string
  description: string
  version?: string
  content: string
  source: 'prebuilt' | 'user-created' | 'imported'
  enabled: boolean
  filePath: string
  createdAt: number
  // Evolution fields
  evolvable: boolean
  evolutionHints?: string[]
  usageCount: number
  lastUsedAt: number | null
  recordCount: number
  memory: string | null
  pendingEvolution: boolean
}

export interface EvolutionData {
  skillId: string
  records: UsageRecord[]
  memory: string | null
  history: EvolutionHistoryEntry[]
  pendingEvolution: PendingEvolution | null
  lastAutoAnalyzedAt?: number
}

export interface UsageRecord {
  id: string
  sessionId: string
  timestamp: number
  lastUpdatedAt: number
  conversation: string
  context?: {
    toolsUsed?: string[]
    iterationCount?: number
  }
  compressed?: boolean
}

export interface EvolutionHistoryEntry {
  timestamp: number
  memorySnapshot: string
  recordIds: string[]
  summary: string
}

export interface PendingEvolution {
  proposedMemory: string
  previousMemory: string
  summary: string
  recordsUsed: string[]
  generatedAt: number
}

interface SkillPreferences {
  [skillId: string]: {
    enabled: boolean
    evolvable?: boolean
    usageCount?: number
    lastUsedAt?: number | null
  }
}

const MAX_RECORDS_PER_SKILL = 20
const MAX_HISTORY_ENTRIES = 10

export class SkillManager {
  private prebuiltDir: string
  private userDir: string
  private importedDir: string
  private prefsPath: string
  /** Serializes concurrent writes to EVOLUTION.json per skill. */
  private writeLocks: Map<string, Promise<void>> = new Map()

  constructor(prebuiltDir: string, userDir: string, importedDir: string) {
    this.prebuiltDir = prebuiltDir
    this.userDir = userDir
    this.importedDir = importedDir
    this.prefsPath = path.join(path.dirname(userDir), 'skill-preferences.json')

    for (const dir of [this.userDir, this.importedDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public: Skill listing & CRUD
  // ---------------------------------------------------------------------------

  listSkills(): SkillData[] {
    const prefs = this.loadPreferences()
    const skills: SkillData[] = []

    // Prebuilt skills
    if (fs.existsSync(this.prebuiltDir)) {
      for (const skill of this.loadSkillsFromDir(this.prebuiltDir, 'prebuilt')) {
        skill.enabled = prefs[skill.id]?.enabled ?? true
        this.applyEvolutionMeta(skill, prefs)
        skills.push(skill)
      }
    }

    // User-created skills
    for (const skill of this.loadSkillsFromDir(this.userDir, 'user-created')) {
      skill.enabled = prefs[skill.id]?.enabled ?? true
      this.applyEvolutionMeta(skill, prefs)
      skills.push(skill)
    }

    // Imported skills
    for (const skill of this.loadSkillsFromDir(this.importedDir, 'imported')) {
      skill.enabled = prefs[skill.id]?.enabled ?? true
      this.applyEvolutionMeta(skill, prefs)
      skills.push(skill)
    }

    return skills
  }

  getEnabledSkills(): SkillData[] {
    return this.listSkills().filter(s => s.enabled)
  }

  toggleSkill(id: string, enabled: boolean): SkillData | null {
    const prefs = this.loadPreferences()
    prefs[id] = { ...prefs[id], enabled }
    this.savePreferences(prefs)

    const skills = this.listSkills()
    return skills.find(s => s.id === id) || null
  }

  createSkill(name: string, description: string, content: string): SkillData {
    const skillName = this.sanitizeName(name)
    const skillDir = path.join(this.userDir, skillName)

    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true })
    }

    // Build SKILL.md with frontmatter if not already present
    let skillContent = content
    if (!content.startsWith('---')) {
      skillContent = `---\nname: ${skillName}\ndescription: ${description}\nversion: 1.0.0\n---\n\n${content}`
    }

    const skillPath = path.join(skillDir, 'SKILL.md')
    fs.writeFileSync(skillPath, skillContent, 'utf-8')

    const skill = this.parseSkillFile(skillPath, 'user-created')
    if (skill) {
      const prefs = this.loadPreferences()
      prefs[skill.id] = { ...prefs[skill.id], enabled: true }
      this.savePreferences(prefs)
      return skill
    }

    // Fallback if parsing fails
    return {
      id: skillName,
      name: skillName,
      displayName: name,
      description: '',
      content,
      source: 'user-created',
      enabled: true,
      filePath: skillPath,
      createdAt: Date.now(),
      evolvable: false,
      usageCount: 0,
      lastUsedAt: null,
      recordCount: 0,
      memory: null,
      pendingEvolution: false,
    }
  }

  importSkill(filePath: string): SkillData | null {
    if (!fs.existsSync(filePath)) return null

    const ext = path.extname(filePath).toLowerCase()

    if (ext === '.md') {
      return this.importMarkdownSkill(filePath)
    } else if (ext === '.zip' || ext === '.skill') {
      return this.importZipSkill(filePath)
    }

    return null
  }

  deleteSkill(id: string): boolean {
    // Only allow deleting user-created and imported skills
    const userPath = path.join(this.userDir, id)
    const importedPath = path.join(this.importedDir, id)

    for (const dirPath of [userPath, importedPath]) {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true })
        const prefs = this.loadPreferences()
        delete prefs[id]
        this.savePreferences(prefs)
        return true
      }
    }

    return false
  }

  // ---------------------------------------------------------------------------
  // Public: Evolution management
  // ---------------------------------------------------------------------------

  /** Record that a skill was used in a session. */
  recordSkillUsage(skillId: string): void {
    const prefs = this.loadPreferences()
    const existing = prefs[skillId] || { enabled: true }
    prefs[skillId] = {
      ...existing,
      usageCount: (existing.usageCount || 0) + 1,
      lastUsedAt: Date.now(),
    }
    this.savePreferences(prefs)
  }

  /** Toggle the evolvable flag. For prebuilt skills, forks to user dir first. */
  toggleEvolvable(skillId: string, evolvable: boolean): SkillData | null {
    const skill = this.listSkills().find(s => s.id === skillId)
    if (!skill) return null

    // Prebuilt skills must be forked before enabling evolution
    if (evolvable && skill.source === 'prebuilt') {
      const forked = this.forkPrebuiltSkill(skillId)
      if (!forked) return null
      // Update prefs for the forked copy
      const prefs = this.loadPreferences()
      prefs[forked.id] = { ...prefs[forked.id], enabled: true, evolvable: true }
      this.savePreferences(prefs)
      return this.listSkills().find(s => s.id === forked.id) || forked
    }

    const prefs = this.loadPreferences()
    prefs[skillId] = { ...prefs[skillId], evolvable }
    this.savePreferences(prefs)

    return this.listSkills().find(s => s.id === skillId) || null
  }

  /** Read EVOLUTION.json for a skill. */
  getEvolutionData(skillId: string): EvolutionData {
    const skill = this.listSkills().find(s => s.id === skillId)
    if (!skill) {
      return { skillId, records: [], memory: null, history: [], pendingEvolution: null }
    }

    const evoPath = path.join(path.dirname(skill.filePath), 'EVOLUTION.json')
    return this.readEvolutionFile(evoPath, skillId)
  }

  /** Write EVOLUTION.json for a skill (serialized via write lock). */
  async saveEvolutionData(skillId: string, data: EvolutionData): Promise<void> {
    // Serialize writes per skill
    const prev = this.writeLocks.get(skillId) || Promise.resolve()
    const next = prev.then(() => this.doSaveEvolution(skillId, data)).catch(() => {})
    this.writeLocks.set(skillId, next)
    await next
  }

  /** Update the SKILL.md file content for a given skill. */
  updateSkillContent(skillId: string, newFullContent: string): boolean {
    const skill = this.listSkills().find(s => s.id === skillId)
    if (!skill) return false
    // Protect prebuilt skills from direct modification
    if (skill.source === 'prebuilt') return false

    try {
      fs.writeFileSync(skill.filePath, newFullContent, 'utf-8')
      return true
    } catch {
      return false
    }
  }

  /** Delete a single usage record from a skill's EVOLUTION.json. */
  async deleteRecord(skillId: string, recordId: string): Promise<EvolutionData> {
    const data = this.getEvolutionData(skillId)
    data.records = data.records.filter(r => r.id !== recordId)
    await this.saveEvolutionData(skillId, data)
    return data
  }

  /**
   * Fork a prebuilt skill into the user directory so it can be evolved
   * without modifying the original.
   */
  forkPrebuiltSkill(skillId: string): SkillData | null {
    const skill = this.listSkills().find(s => s.id === skillId && s.source === 'prebuilt')
    if (!skill) return null

    const destDir = path.join(this.userDir, skill.name)
    if (fs.existsSync(destDir)) {
      // Already forked
      return this.parseSkillFile(path.join(destDir, 'SKILL.md'), 'user-created')
    }

    try {
      fs.mkdirSync(destDir, { recursive: true })
      // Copy SKILL.md
      fs.copyFileSync(skill.filePath, path.join(destDir, 'SKILL.md'))
      // Copy EVOLUTION.json if it exists
      const srcEvo = path.join(path.dirname(skill.filePath), 'EVOLUTION.json')
      if (fs.existsSync(srcEvo)) {
        fs.copyFileSync(srcEvo, path.join(destDir, 'EVOLUTION.json'))
      }

      const forked = this.parseSkillFile(path.join(destDir, 'SKILL.md'), 'user-created')
      if (forked) {
        // Disable the original prebuilt version to avoid duplicate
        const prefs = this.loadPreferences()
        prefs[skillId] = { ...prefs[skillId], enabled: false }
        prefs[forked.id] = { ...prefs[forked.id], enabled: true, evolvable: true }
        this.savePreferences(prefs)
      }
      return forked
    } catch {
      return null
    }
  }

  /** Get the skill directory path for a skill ID. */
  getSkillDir(skillId: string): string | null {
    const skill = this.listSkills().find(s => s.id === skillId)
    if (!skill) return null
    return path.dirname(skill.filePath)
  }

  // ---------------------------------------------------------------------------
  // Private: Evolution helpers
  // ---------------------------------------------------------------------------

  /** Populate evolution metadata on a SkillData from prefs + EVOLUTION.json. */
  private applyEvolutionMeta(skill: SkillData, prefs: SkillPreferences): void {
    const pref = prefs[skill.id]
    skill.evolvable = pref?.evolvable ?? skill.evolvable
    skill.usageCount = pref?.usageCount ?? 0
    skill.lastUsedAt = pref?.lastUsedAt ?? null

    // Read lightweight info from EVOLUTION.json
    const evoPath = path.join(path.dirname(skill.filePath), 'EVOLUTION.json')
    try {
      if (fs.existsSync(evoPath)) {
        const raw = JSON.parse(fs.readFileSync(evoPath, 'utf-8')) as Partial<EvolutionData>
        skill.recordCount = Array.isArray(raw.records) ? raw.records.length : 0
        skill.memory = typeof raw.memory === 'string' ? raw.memory : null
        skill.pendingEvolution = raw.pendingEvolution != null
      }
    } catch { /* ignore corrupt file */ }
  }

  private readEvolutionFile(filePath: string, skillId: string): EvolutionData {
    const empty: EvolutionData = { skillId, records: [], memory: null, history: [], pendingEvolution: null }
    try {
      if (!fs.existsSync(filePath)) return empty
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      return {
        skillId: raw.skillId || skillId,
        records: Array.isArray(raw.records) ? raw.records : [],
        memory: typeof raw.memory === 'string' ? raw.memory : null,
        history: Array.isArray(raw.history) ? raw.history : [],
        pendingEvolution: raw.pendingEvolution ?? null,
        lastAutoAnalyzedAt: typeof raw.lastAutoAnalyzedAt === 'number' ? raw.lastAutoAnalyzedAt : undefined,
      }
    } catch {
      return empty
    }
  }

  private doSaveEvolution(skillId: string, data: EvolutionData): void {
    const skill = this.listSkills().find(s => s.id === skillId)
    if (!skill) return
    const evoPath = path.join(path.dirname(skill.filePath), 'EVOLUTION.json')

    // Enforce limits
    if (data.records.length > MAX_RECORDS_PER_SKILL) {
      // Keep most recent records
      data.records.sort((a, b) => a.timestamp - b.timestamp)
      data.records = data.records.slice(-MAX_RECORDS_PER_SKILL)
    }
    if (data.history.length > MAX_HISTORY_ENTRIES) {
      data.history = data.history.slice(-MAX_HISTORY_ENTRIES)
    }

    fs.writeFileSync(evoPath, JSON.stringify(data, null, 2), 'utf-8')
  }

  // ---------------------------------------------------------------------------
  // Private: Import helpers
  // ---------------------------------------------------------------------------

  private importMarkdownSkill(filePath: string): SkillData | null {
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
    const { metadata } = this.parseFrontmatter(content)

    if (!metadata.name || !metadata.description) {
      return null
    }

    const skillName = this.sanitizeName(metadata.name)
    const skillDir = path.join(this.importedDir, skillName)

    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true })
    }

    const destPath = path.join(skillDir, 'SKILL.md')
    fs.copyFileSync(filePath, destPath)

    const skill = this.parseSkillFile(destPath, 'imported')
    if (skill) {
      const prefs = this.loadPreferences()
      prefs[skill.id] = { ...prefs[skill.id], enabled: true }
      this.savePreferences(prefs)
    }
    return skill
  }

  private importZipSkill(filePath: string): SkillData | null {
    try {
      const { execSync } = require('child_process')
      const tempDir = path.join(this.importedDir, `_temp_${Date.now()}`)
      fs.mkdirSync(tempDir, { recursive: true })

      execSync(`unzip -o "${filePath}" -d "${tempDir}"`, { stdio: 'pipe' })

      const skillMd = this.findSkillMd(tempDir)
      if (!skillMd) {
        fs.rmSync(tempDir, { recursive: true, force: true })
        return null
      }

      const content = fs.readFileSync(skillMd, 'utf-8')
      const { metadata } = this.parseFrontmatter(content)
      const skillName = this.sanitizeName(metadata.name || path.basename(filePath, path.extname(filePath)))

      const finalDir = path.join(this.importedDir, skillName)
      if (fs.existsSync(finalDir)) {
        fs.rmSync(finalDir, { recursive: true, force: true })
      }

      const skillMdDir = path.dirname(skillMd)
      if (skillMdDir !== tempDir) {
        fs.renameSync(skillMdDir, finalDir)
        fs.rmSync(tempDir, { recursive: true, force: true })
      } else {
        fs.renameSync(tempDir, finalDir)
      }

      const skill = this.parseSkillFile(path.join(finalDir, 'SKILL.md'), 'imported')
      if (skill) {
        const prefs = this.loadPreferences()
        prefs[skill.id] = { ...prefs[skill.id], enabled: true }
        this.savePreferences(prefs)
      }
      return skill
    } catch {
      return null
    }
  }

  private findSkillMd(dir: string): string | null {
    const direct = path.join(dir, 'SKILL.md')
    if (fs.existsSync(direct)) return direct

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const nested = path.join(dir, entry.name, 'SKILL.md')
          if (fs.existsSync(nested)) return nested
        }
      }
    } catch { /* ignore */ }

    return null
  }

  // ---------------------------------------------------------------------------
  // Private: Parsing
  // ---------------------------------------------------------------------------

  private loadSkillsFromDir(dir: string, source: 'prebuilt' | 'user-created' | 'imported'): SkillData[] {
    const skills: SkillData[] = []

    if (!fs.existsSync(dir)) return skills

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue
        const skillMdPath = path.join(dir, entry.name, 'SKILL.md')
        if (fs.existsSync(skillMdPath)) {
          const skill = this.parseSkillFile(skillMdPath, source)
          if (skill) skills.push(skill)
        }
      }
    } catch { /* ignore */ }

    return skills
  }

  private parseSkillFile(filePath: string, source: 'prebuilt' | 'user-created' | 'imported'): SkillData | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const { metadata, body } = this.parseFrontmatter(content)

      const name = metadata.name || path.basename(path.dirname(filePath))
      const displayName = name
        .split('-')
        .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')

      // Parse evolution-hints (YAML list under the key)
      const evolutionHints = this.parseEvolutionHints(content)
      const evolvable = metadata.evolvable === 'true'

      return {
        id: name,
        name,
        displayName,
        description: metadata.description || '',
        version: metadata.version,
        content: body.trim(),
        source,
        enabled: true,
        filePath,
        createdAt: fs.statSync(filePath).birthtimeMs || Date.now(),
        evolvable,
        evolutionHints: evolutionHints.length > 0 ? evolutionHints : undefined,
        usageCount: 0,
        lastUsedAt: null,
        recordCount: 0,
        memory: null,
        pendingEvolution: false,
      }
    } catch {
      return null
    }
  }

  /**
   * Parse evolution-hints from YAML frontmatter.
   * Supports the list format:
   * ```
   * evolution-hints:
   *   - hint one
   *   - hint two
   * ```
   */
  private parseEvolutionHints(content: string): string[] {
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch) return []

    const hints: string[] = []
    const lines = fmMatch[1].split('\n')
    let inHints = false

    for (const line of lines) {
      if (/^evolution-hints\s*:/.test(line)) {
        inHints = true
        continue
      }
      if (inHints) {
        const itemMatch = line.match(/^\s+-\s+(.+)/)
        if (itemMatch) {
          hints.push(itemMatch[1].trim())
        } else if (/^\S/.test(line)) {
          // New top-level key — stop parsing hints
          break
        }
      }
    }

    return hints
  }

  private parseFrontmatter(content: string): { metadata: Record<string, string>; body: string } {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
    if (!match) return { metadata: {}, body: content }

    const metaLines = match[1].split('\n')
    const metadata: Record<string, string> = {}
    for (const line of metaLines) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.substring(0, colonIdx).trim()
      const value = line.substring(colonIdx + 1).trim()
      // Skip list items (evolution-hints children)
      if (line.match(/^\s+-/)) continue
      if (key && value) metadata[key] = value
    }

    return { metadata, body: match[2] }
  }

  private sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      || `skill-${uuidv4().slice(0, 8)}`
  }

  private loadPreferences(): SkillPreferences {
    try {
      if (fs.existsSync(this.prefsPath)) {
        return JSON.parse(fs.readFileSync(this.prefsPath, 'utf-8'))
      }
    } catch { /* ignore */ }
    return {}
  }

  private savePreferences(prefs: SkillPreferences): void {
    try {
      fs.writeFileSync(this.prefsPath, JSON.stringify(prefs, null, 2), 'utf-8')
    } catch { /* ignore */ }
  }
}
