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
}

interface SkillPreferences {
  [skillId: string]: { enabled: boolean }
}

export class SkillManager {
  private prebuiltDir: string
  private userDir: string
  private importedDir: string
  private prefsPath: string

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

  listSkills(): SkillData[] {
    const prefs = this.loadPreferences()
    const skills: SkillData[] = []

    // Prebuilt skills
    if (fs.existsSync(this.prebuiltDir)) {
      for (const skill of this.loadSkillsFromDir(this.prebuiltDir, 'prebuilt')) {
        skill.enabled = prefs[skill.id]?.enabled ?? true
        skills.push(skill)
      }
    }

    // User-created skills
    for (const skill of this.loadSkillsFromDir(this.userDir, 'user-created')) {
      skill.enabled = prefs[skill.id]?.enabled ?? true
      skills.push(skill)
    }

    // Imported skills
    for (const skill of this.loadSkillsFromDir(this.importedDir, 'imported')) {
      skill.enabled = prefs[skill.id]?.enabled ?? true
      skills.push(skill)
    }

    return skills
  }

  getEnabledSkills(): SkillData[] {
    return this.listSkills().filter(s => s.enabled)
  }

  toggleSkill(id: string, enabled: boolean): SkillData | null {
    const prefs = this.loadPreferences()
    prefs[id] = { enabled }
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
      prefs[skill.id] = { enabled: true }
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
    }
  }

  importSkill(filePath: string): SkillData | null {
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

  private importMarkdownSkill(filePath: string): SkillData | null {
    const content = fs.readFileSync(filePath, 'utf-8')
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
      prefs[skill.id] = { enabled: true }
      this.savePreferences(prefs)
    }
    return skill
  }

  private importZipSkill(filePath: string): SkillData | null {
    // For .zip/.skill files, we expect a SKILL.md inside
    // Use Node.js built-in to extract - for now, handle simple case
    try {
      const { execSync } = require('child_process')
      const tempDir = path.join(this.importedDir, `_temp_${Date.now()}`)
      fs.mkdirSync(tempDir, { recursive: true })

      execSync(`unzip -o "${filePath}" -d "${tempDir}"`, { stdio: 'pipe' })

      // Find SKILL.md in extracted contents
      const skillMd = this.findSkillMd(tempDir)
      if (!skillMd) {
        fs.rmSync(tempDir, { recursive: true, force: true })
        return null
      }

      const content = fs.readFileSync(skillMd, 'utf-8')
      const { metadata } = this.parseFrontmatter(content)
      const skillName = this.sanitizeName(metadata.name || path.basename(filePath, path.extname(filePath)))

      // Move to final location
      const finalDir = path.join(this.importedDir, skillName)
      if (fs.existsSync(finalDir)) {
        fs.rmSync(finalDir, { recursive: true, force: true })
      }

      // If SKILL.md is in a subdirectory, move that directory
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
        prefs[skill.id] = { enabled: true }
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
      }
    } catch {
      return null
    }
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
