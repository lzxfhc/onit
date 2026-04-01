import path from 'path'
import fs from 'fs'
import os from 'os'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import { ToolExecutionResult } from './types'

// Lazy-loaded playwright-core
let playwrightModule: typeof import('playwright-core') | null = null

async function getPlaywright() {
  if (!playwrightModule) {
    playwrightModule = await import('playwright-core')
  }
  return playwrightModule
}

export interface InteractiveElement {
  index: number
  tag: string
  role?: string
  text: string
  type?: string
  selector: string
  attributes?: Record<string, string>
}

interface BrowserManagerOptions {
  apiConfig: {
    billingMode: string
    apiKey: string
    model?: string
    customBaseUrl?: string
    codingPlanProvider?: string
  }
  artifactsDir?: string
  sessionId?: string
}

const PAGE_LOAD_TIMEOUT = 30000
const ACTION_TIMEOUT = 10000
const MAX_ELEMENTS = 50
const MAX_EXTRACT_CHARS = 50000
const ELEMENT_TEXT_MAX = 80

export class BrowserManager {
  private browser: import('playwright-core').Browser | null = null
  private page: import('playwright-core').Page | null = null
  private cachedElements: InteractiveElement[] = []
  private apiConfig: BrowserManagerOptions['apiConfig']
  private artifactsDir: string | null
  private sessionId: string

  constructor(options: BrowserManagerOptions) {
    this.apiConfig = options.apiConfig
    this.artifactsDir = options.artifactsDir || null
    this.sessionId = options.sessionId || 'default'
  }

  // --- Lifecycle ---

  private async ensureBrowser(): Promise<import('playwright-core').Page> {
    if (this.page && !this.page.isClosed()) return this.page

    const pw = await getPlaywright()

    // Try system Chrome first, fall back to bundled Chromium
    try {
      this.browser = await pw.chromium.launch({
        channel: 'chrome',
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      })
    } catch {
      // No system Chrome, try default Chromium
      this.browser = await pw.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      })
    }

    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    })
    this.page = await context.newPage()
    return this.page
  }

  async close(): Promise<void> {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => {})
      }
      if (this.browser) {
        await this.browser.close().catch(() => {})
      }
    } finally {
      this.page = null
      this.browser = null
      this.cachedElements = []
    }
  }

  // --- Public tool handler ---

  async handleToolCall(toolName: string, argsStr: string): Promise<ToolExecutionResult> {
    let args: any
    try {
      args = JSON.parse(argsStr)
    } catch {
      return { success: false, output: `Invalid tool arguments: ${argsStr}`, riskLevel: 'safe' }
    }

    try {
      switch (toolName) {
        case 'browser_navigate':
          return await this.navigate(args.url)
        case 'browser_action':
          return await this.performAction(args)
        case 'browser_extract':
          return await this.extractContent(args)
        case 'browser_screenshot':
          return await this.screenshot(args)
        case 'browser_close':
          return await this.closeAndReport()
        default:
          return { success: false, output: `Unknown browser tool: ${toolName}`, riskLevel: 'safe' }
      }
    } catch (error: any) {
      return { success: false, output: `Browser error: ${error.message}`, riskLevel: 'safe' }
    }
  }

  // --- Navigate ---

  private async navigate(url: string): Promise<ToolExecutionResult> {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return { success: false, output: 'URL must start with http:// or https://', riskLevel: 'safe' }
    }

    const page = await this.ensureBrowser()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT })

    // Wait briefly for dynamic content
    await page.waitForTimeout(1000)

    const title = await page.title()
    const currentUrl = page.url()
    this.cachedElements = await this.getInteractiveElements(page)

    const elementsText = this.formatElementsList(this.cachedElements)

    return {
      success: true,
      output: `Page loaded: ${title}\nURL: ${currentUrl}\n\nInteractive elements (${this.cachedElements.length}):\n${elementsText}`,
      riskLevel: 'safe',
    }
  }

  // --- Action ---

  private async performAction(args: {
    action: string
    element?: string
    selector?: string
    value?: string
    description?: string
  }): Promise<ToolExecutionResult> {
    const page = await this.ensureBrowser()
    const { action, element, selector, value } = args

    // Handle actions that don't need an element
    if (action === 'scroll') {
      const direction = value?.toLowerCase() === 'up' ? -500 : 500
      await page.evaluate((d) => window.scrollBy(0, d), direction)
      this.cachedElements = await this.getInteractiveElements(page)
      return {
        success: true,
        output: `Scrolled ${value === 'up' ? 'up' : 'down'}.\n\nInteractive elements (${this.cachedElements.length}):\n${this.formatElementsList(this.cachedElements)}`,
        riskLevel: 'moderate',
      }
    }

    if (action === 'press_key') {
      if (!value) return { success: false, output: 'Missing "value" for press_key action', riskLevel: 'moderate' }
      await page.keyboard.press(value, { timeout: ACTION_TIMEOUT })
      await page.waitForTimeout(500)
      this.cachedElements = await this.getInteractiveElements(page)
      return {
        success: true,
        output: `Pressed key: ${value}\n\nInteractive elements (${this.cachedElements.length}):\n${this.formatElementsList(this.cachedElements)}`,
        riskLevel: 'moderate',
      }
    }

    if (action === 'wait') {
      const ms = Math.min(parseInt(value || '2000', 10) || 2000, 10000)
      await page.waitForTimeout(ms)
      this.cachedElements = await this.getInteractiveElements(page)
      return {
        success: true,
        output: `Waited ${ms}ms.\n\nInteractive elements (${this.cachedElements.length}):\n${this.formatElementsList(this.cachedElements)}`,
        riskLevel: 'moderate',
      }
    }

    // Resolve the target element
    let locator: import('playwright-core').Locator | null = null

    if (selector) {
      // CSS selector mode (exact)
      locator = page.locator(selector).first()
    } else if (element) {
      // Natural language → resolve via heuristic + LLM fallback
      const resolved = await this.resolveElement(page, element)
      if (!resolved) {
        return { success: false, output: `Could not find element matching: "${element}"`, riskLevel: 'moderate' }
      }
      locator = page.locator(resolved.selector).first()
    } else {
      return { success: false, output: 'Either "element" or "selector" is required for this action', riskLevel: 'moderate' }
    }

    // Execute the action
    switch (action) {
      case 'click':
        await locator.click({ timeout: ACTION_TIMEOUT })
        break
      case 'type':
        if (!value) return { success: false, output: 'Missing "value" for type action', riskLevel: 'moderate' }
        await locator.fill(value, { timeout: ACTION_TIMEOUT })
        break
      case 'select':
        if (!value) return { success: false, output: 'Missing "value" for select action', riskLevel: 'moderate' }
        await locator.selectOption(value, { timeout: ACTION_TIMEOUT })
        break
      case 'hover':
        await locator.hover({ timeout: ACTION_TIMEOUT })
        break
      default:
        return { success: false, output: `Unknown action: ${action}`, riskLevel: 'moderate' }
    }

    // Wait for potential navigation / dynamic update
    await page.waitForTimeout(800)

    this.cachedElements = await this.getInteractiveElements(page)
    return {
      success: true,
      output: `Action "${action}" completed.\n\nInteractive elements (${this.cachedElements.length}):\n${this.formatElementsList(this.cachedElements)}`,
      riskLevel: 'moderate',
    }
  }

  // --- Extract ---

  private async extractContent(args: {
    mode?: string
    selector?: string
    schema?: string
  }): Promise<ToolExecutionResult> {
    const page = await this.ensureBrowser()
    const mode = args.mode || 'text'

    switch (mode) {
      case 'text': {
        const text = await page.evaluate(() => {
          // Remove script/style/nav/footer for cleaner text
          const clone = document.body.cloneNode(true) as HTMLElement
          clone.querySelectorAll('script, style, nav, footer, header, [aria-hidden="true"]').forEach(el => el.remove())
          return clone.innerText || clone.textContent || ''
        })
        const trimmed = text.replace(/\n{3,}/g, '\n\n').trim().substring(0, MAX_EXTRACT_CHARS)
        return { success: true, output: trimmed, riskLevel: 'safe' }
      }
      case 'html': {
        const html = await page.content()
        return { success: true, output: html.substring(0, MAX_EXTRACT_CHARS), riskLevel: 'safe' }
      }
      case 'selector': {
        if (!args.selector) return { success: false, output: 'Missing "selector" for selector mode', riskLevel: 'safe' }
        const elements = await page.locator(args.selector).allTextContents()
        const result = elements.join('\n').substring(0, MAX_EXTRACT_CHARS)
        return { success: true, output: result || '(no matching elements found)', riskLevel: 'safe' }
      }
      case 'structured': {
        // Extract structured data: get all text from tables/lists
        const data = await page.evaluate(() => {
          const tables: string[] = []
          document.querySelectorAll('table').forEach(table => {
            const rows: string[][] = []
            table.querySelectorAll('tr').forEach(tr => {
              const cells: string[] = []
              tr.querySelectorAll('th, td').forEach(cell => {
                cells.push((cell as HTMLElement).innerText.trim())
              })
              if (cells.length > 0) rows.push(cells)
            })
            if (rows.length > 0) {
              tables.push(rows.map(r => r.join(' | ')).join('\n'))
            }
          })

          const lists: string[] = []
          document.querySelectorAll('ul, ol').forEach(list => {
            const items: string[] = []
            list.querySelectorAll(':scope > li').forEach(li => {
              items.push('- ' + (li as HTMLElement).innerText.trim().substring(0, 200))
            })
            if (items.length > 0) lists.push(items.join('\n'))
          })

          return { tables, lists }
        })
        const result = [
          data.tables.length > 0 ? `Tables:\n${data.tables.join('\n\n')}` : '',
          data.lists.length > 0 ? `Lists:\n${data.lists.join('\n\n')}` : '',
        ].filter(Boolean).join('\n\n').substring(0, MAX_EXTRACT_CHARS)
        return { success: true, output: result || '(no structured data found)', riskLevel: 'safe' }
      }
      default:
        return { success: false, output: `Unknown extract mode: ${mode}`, riskLevel: 'safe' }
    }
  }

  // --- Screenshot ---

  private async screenshot(args: { fullPage?: boolean }): Promise<ToolExecutionResult> {
    const page = await this.ensureBrowser()

    const dir = this.artifactsDir
      ? path.join(this.artifactsDir, 'screenshots', this.sessionId)
      : path.join(os.tmpdir(), 'onit-screenshots')
    fs.mkdirSync(dir, { recursive: true })

    const fileName = `screenshot-${Date.now()}.png`
    const filePath = path.join(dir, fileName)

    await page.screenshot({
      path: filePath,
      fullPage: args.fullPage ?? false,
    })

    const { width, height } = page.viewportSize() || { width: 1280, height: 900 }

    return {
      success: true,
      output: JSON.stringify({ filePath, width, height }),
      riskLevel: 'safe',
    }
  }

  // --- Close ---

  private async closeAndReport(): Promise<ToolExecutionResult> {
    await this.close()
    return { success: true, output: 'Browser closed.', riskLevel: 'safe' }
  }

  // --- Interactive Elements ---

  private async getInteractiveElements(page: import('playwright-core').Page): Promise<InteractiveElement[]> {
    const elements: InteractiveElement[] = await page.evaluate(() => {
      const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']
      const interactiveRoles = ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option', 'combobox', 'textbox', 'searchbox']

      const results: any[] = []
      const allElements = document.querySelectorAll('*')

      for (let i = 0; i < allElements.length && results.length < 80; i++) {
        const el = allElements[i] as HTMLElement

        // Skip hidden elements
        if (el.offsetParent === null && el.tagName !== 'BODY') continue
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue

        const tag = el.tagName
        const role = el.getAttribute('role')
        const isInteractive =
          interactiveTags.includes(tag) ||
          (role && interactiveRoles.includes(role)) ||
          el.hasAttribute('onclick') ||
          el.hasAttribute('tabindex') ||
          (style.cursor === 'pointer' && (el.textContent || '').trim().length > 0 && (el.textContent || '').trim().length < 100)

        if (!isInteractive) continue

        // Get visible text
        let text = ''
        if (el instanceof HTMLInputElement) {
          text = el.value || el.placeholder || ''
        } else {
          text = el.getAttribute('aria-label') || el.innerText || el.textContent || ''
        }
        text = text.trim().replace(/\s+/g, ' ').substring(0, 80)
        if (!text && tag !== 'INPUT') continue // Skip elements with no identifiable text (except inputs)

        // Build a unique selector
        let selector = ''
        if (el.id) {
          selector = `#${CSS.escape(el.id)}`
        } else {
          // Use tag + nth-of-type
          const parent = el.parentElement
          if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === tag)
            const idx = siblings.indexOf(el) + 1
            const parentSelector = parent.id ? `#${CSS.escape(parent.id)}` : parent.tagName.toLowerCase()
            selector = `${parentSelector} > ${tag.toLowerCase()}:nth-of-type(${idx})`
          } else {
            selector = tag.toLowerCase()
          }
        }

        // Key attributes
        const attrs: Record<string, string> = {}
        if (el.getAttribute('href')) attrs.href = el.getAttribute('href')!.substring(0, 200)
        if (el.getAttribute('name')) attrs.name = el.getAttribute('name')!
        if (el.getAttribute('placeholder')) attrs.placeholder = el.getAttribute('placeholder')!
        if (el.id) attrs.id = el.id

        results.push({
          tag: tag.toLowerCase(),
          role: role || undefined,
          text,
          type: el instanceof HTMLInputElement ? el.type : undefined,
          selector,
          attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
        })
      }

      return results
    })

    // Assign indices and limit
    return elements.slice(0, MAX_ELEMENTS).map((el, idx) => ({ ...el, index: idx }))
  }

  private formatElementsList(elements: InteractiveElement[]): string {
    if (elements.length === 0) return '(no interactive elements found)'
    return elements.map(el => {
      const tag = `<${el.tag}${el.type ? ` type="${el.type}"` : ''}>`
      const role = el.role ? ` [role=${el.role}]` : ''
      return `[${el.index}] ${tag}${role} "${el.text}"`
    }).join('\n')
  }

  // --- Element Resolution: Heuristic + LLM Fallback ---

  private async resolveElement(
    page: import('playwright-core').Page,
    description: string
  ): Promise<InteractiveElement | null> {
    // Refresh elements if cache is empty
    if (this.cachedElements.length === 0) {
      this.cachedElements = await this.getInteractiveElements(page)
    }

    // 1. Try by index: "[3]" or "3"
    const indexMatch = description.match(/^\[?(\d+)\]?$/)
    if (indexMatch) {
      const idx = parseInt(indexMatch[1], 10)
      const el = this.cachedElements.find(e => e.index === idx)
      if (el) return el
    }

    // 2. Heuristic matching
    const heuristic = this.matchHeuristic(description, this.cachedElements)
    if (heuristic) return heuristic

    // 3. LLM fallback
    const llmResult = await this.matchWithLLM(description, this.cachedElements)
    return llmResult
  }

  private matchHeuristic(description: string, elements: InteractiveElement[]): InteractiveElement | null {
    const desc = this.normalize(description)
    if (!desc) return null

    // 1. Exact text match
    const exact = elements.find(e => this.normalize(e.text) === desc)
    if (exact) return exact

    // 2. Contains match (single result)
    const contains = elements.filter(e => {
      const norm = this.normalize(e.text)
      return norm.includes(desc) || desc.includes(norm)
    })
    if (contains.length === 1) return contains[0]

    // 3. Attribute match (id, name, placeholder)
    const attrMatch = elements.find(e => {
      const attrs = e.attributes
      if (!attrs) return false
      return (
        attrs.id === desc ||
        attrs.name === desc ||
        this.normalize(attrs.placeholder || '') === desc
      )
    })
    if (attrMatch) return attrMatch

    // 4. Score-based: pick top1 if clearly better than top2
    const scored = elements.map(e => ({
      element: e,
      score: this.similarityScore(desc, this.normalize(e.text)),
    })).sort((a, b) => b.score - a.score)

    if (scored.length >= 1 && scored[0].score > 0.6) {
      if (scored.length === 1 || scored[0].score - scored[1].score > 0.2) {
        return scored[0].element
      }
    }

    return null
  }

  private async matchWithLLM(
    description: string,
    elements: InteractiveElement[]
  ): Promise<InteractiveElement | null> {
    if (elements.length === 0) return null

    // Limit to top 20 candidates by rough relevance
    const desc = this.normalize(description)
    const candidates = elements
      .map(e => ({ element: e, score: this.similarityScore(desc, this.normalize(e.text)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(c => c.element)

    const elementsList = candidates.map(e => {
      const tag = `<${e.tag}${e.type ? ` type="${e.type}"` : ''}>`
      const role = e.role ? ` [role=${e.role}]` : ''
      return `[${e.index}] ${tag}${role} "${e.text}"`
    }).join('\n')

    const prompt = `You are an element selector. Given the user's intent and a list of interactive elements on a web page, return the index number of the best matching element. Return ONLY the number, nothing else.

User intent: "${description}"

Elements:
${elementsList}

Answer:`

    try {
      const response = await this.callLLMSimple(prompt)
      const match = response.trim().match(/\d+/)
      if (match) {
        const idx = parseInt(match[0], 10)
        return candidates.find(e => e.index === idx) || null
      }
    } catch {
      // LLM fallback failed, return null
    }

    return null
  }

  // --- LLM Helper (lightweight, non-streaming) ---

  private async callLLMSimple(prompt: string): Promise<string> {
    const { apiKey, codingPlanProvider, billingMode, customBaseUrl, model } = this.apiConfig

    let baseUrl: string
    let requestModel: string

    if (billingMode === 'api-call') {
      baseUrl = customBaseUrl || 'https://qianfan.baidubce.com/v2/chat/completions'
      requestModel = model || 'ernie-4.5-8k'
    } else {
      // Default: coding plan
      const providerUrls: Record<string, { url: string; model: string }> = {
        qianfan: { url: 'https://qianfan.baidubce.com/v2/coding/chat/completions', model: 'qianfan-code-latest' },
        volcengine: { url: 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions', model: 'ark-code-latest' },
        dashscope: { url: 'https://coding.dashscope.aliyuncs.com/v1/chat/completions', model: 'qwen3.5-plus' },
      }
      const provider = providerUrls[codingPlanProvider || 'qianfan'] || providerUrls.qianfan
      baseUrl = provider.url
      requestModel = provider.model
    }

    const body = JSON.stringify({
      model: requestModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20,
      temperature: 0,
      stream: false,
    })

    return new Promise<string>((resolve, reject) => {
      const url = new URL(baseUrl)
      const transport = url.protocol === 'https:' ? https : http
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (res: any) => {
          let data = ''
          res.on('data', (chunk: Buffer) => { data += chunk.toString() })
          res.on('end', () => {
            try {
              const json = JSON.parse(data)
              const content = json.choices?.[0]?.message?.content || ''
              resolve(content)
            } catch {
              reject(new Error('Failed to parse LLM response'))
            }
          })
        }
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('LLM request timeout'))
      })
      req.write(body)
      req.end()
    })
  }

  // --- Utility ---

  private normalize(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
  }

  private similarityScore(a: string, b: string): number {
    if (!a || !b) return 0
    if (a === b) return 1

    // Simple character bigram similarity (Dice coefficient)
    const bigrams = (s: string) => {
      const set: string[] = []
      for (let i = 0; i < s.length - 1; i++) {
        set.push(s.substring(i, i + 2))
      }
      return set
    }

    const aBigrams = bigrams(a)
    const bBigrams = bigrams(b)
    if (aBigrams.length === 0 || bBigrams.length === 0) return 0

    let matches = 0
    const bCopy = [...bBigrams]
    for (const bg of aBigrams) {
      const idx = bCopy.indexOf(bg)
      if (idx !== -1) {
        matches++
        bCopy.splice(idx, 1)
      }
    }

    return (2 * matches) / (aBigrams.length + bBigrams.length)
  }
}
