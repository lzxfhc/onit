/**
 * Unified file content extraction.
 *
 * Handles text files, PDF, DOCX, PPTX, XLSX, ODS, RTF, CSV, images.
 * Used by both buildAttachedFileMessages (user attachments) and read_file tool.
 */

import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max file size we attempt to parse (50MB). */
const MAX_PARSE_SIZE = 50 * 1024 * 1024

/** Max characters to return from extraction. */
const MAX_EXTRACT_CHARS = 30000

/** Max PDF pages to extract. */
const MAX_PDF_PAGES = 30

/** Max spreadsheet rows to extract. */
const MAX_SPREADSHEET_ROWS = 500

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.swift', '.kt', '.scala', '.r', '.m',
  '.css', '.scss', '.less', '.sass',
  '.html', '.htm', '.xml', '.svg',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bash', '.zsh', '.fish', '.bat', '.ps1',
  '.sql', '.graphql', '.proto',
  '.env', '.gitignore', '.dockerignore', '.editorconfig',
  '.csv', '.tsv', '.log',
])

const OFFICE_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.pptx', '.ppt',
  '.xlsx', '.xls', '.odt', '.odp', '.ods', '.rtf',
])

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
])

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv'])
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.rar', '.7z', '.bz2'])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  /** Extracted text content. */
  content: string
  /** File type category. */
  fileType: 'text' | 'document' | 'spreadsheet' | 'presentation' | 'image' | 'audio' | 'video' | 'archive' | 'unknown'
  /** File metadata header. */
  header: string
  /** Whether content was truncated. */
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

export async function extractFileContent(filePath: string): Promise<ExtractionResult> {
  if (!fs.existsSync(filePath)) {
    return { content: '', fileType: 'unknown', header: `[File not found: ${filePath}]`, truncated: false }
  }

  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    return { content: '', fileType: 'unknown', header: `[Not a file: ${filePath}]`, truncated: false }
  }

  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  const fileSize = formatSize(stat.size)

  // File too large
  if (stat.size > MAX_PARSE_SIZE) {
    return {
      content: '',
      fileType: 'unknown',
      header: `[File: ${fileName} | Size: ${fileSize} | Too large to process (max ${formatSize(MAX_PARSE_SIZE)})]`,
      truncated: false,
    }
  }

  // Empty file
  if (stat.size === 0) {
    return { content: '', fileType: 'text', header: `[File: ${fileName} | Empty file]`, truncated: false }
  }

  try {
    // Text files — direct read
    if (TEXT_EXTENSIONS.has(ext)) {
      return extractTextFile(filePath, fileName, fileSize)
    }

    // Office documents — officeparser
    if (OFFICE_EXTENSIONS.has(ext)) {
      return await extractOfficeFile(filePath, fileName, fileSize, ext)
    }

    // Images — metadata only (no OCR in MVP)
    if (IMAGE_EXTENSIONS.has(ext)) {
      return extractImageInfo(filePath, fileName, fileSize, ext)
    }

    // Audio/Video — metadata only
    if (AUDIO_EXTENSIONS.has(ext)) {
      return { content: '', fileType: 'audio', header: `[Audio: ${fileName} | Size: ${fileSize}]`, truncated: false }
    }
    if (VIDEO_EXTENSIONS.has(ext)) {
      return { content: '', fileType: 'video', header: `[Video: ${fileName} | Size: ${fileSize}]`, truncated: false }
    }

    // Archives
    if (ARCHIVE_EXTENSIONS.has(ext)) {
      return { content: '', fileType: 'archive', header: `[Archive: ${fileName} | Size: ${fileSize}]`, truncated: false }
    }

    // Unknown — try reading as text, fall back gracefully
    return extractTextFile(filePath, fileName, fileSize)

  } catch (err: any) {
    return {
      content: '',
      fileType: 'unknown',
      header: `[File: ${fileName} | Parse error: ${err.message || 'Unknown error'}]`,
      truncated: false,
    }
  }
}

/**
 * Check if a file is a supported non-text type that extractFileContent can handle.
 * Used by read_file to decide whether to use extraction vs raw read.
 */
export function isExtractableFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return OFFICE_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)
}

// ---------------------------------------------------------------------------
// Text files
// ---------------------------------------------------------------------------

function extractTextFile(filePath: string, fileName: string, fileSize: string): ExtractionResult {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')

    // Check for binary content (NULL bytes = likely binary)
    if (raw.includes('\0')) {
      return {
        content: '',
        fileType: 'unknown',
        header: `[Binary file: ${fileName} | Size: ${fileSize} | Cannot extract text]`,
        truncated: false,
      }
    }

    const truncated = raw.length > MAX_EXTRACT_CHARS
    const content = truncated ? raw.slice(0, MAX_EXTRACT_CHARS) + '\n\n[Content truncated]' : raw

    return {
      content,
      fileType: 'text',
      header: `[File: ${fileName} | Size: ${fileSize}${truncated ? ' | Truncated' : ''}]`,
      truncated,
    }
  } catch {
    return {
      content: '',
      fileType: 'unknown',
      header: `[File: ${fileName} | Size: ${fileSize} | Cannot read as text]`,
      truncated: false,
    }
  }
}

// ---------------------------------------------------------------------------
// Office documents (PDF, DOCX, PPTX, XLSX, ODS, RTF)
// ---------------------------------------------------------------------------

async function extractOfficeFile(
  filePath: string,
  fileName: string,
  fileSize: string,
  ext: string,
): Promise<ExtractionResult> {
  // Dynamic import — officeparser might be CJS or ESM
  let parseOffice: (filePath: string, config?: any) => Promise<any>
  try {
    const op = require('officeparser')
    parseOffice = op.parseOffice || op.default?.parseOffice
  } catch {
    return {
      content: '',
      fileType: 'document',
      header: `[File: ${fileName} | officeparser not available]`,
      truncated: false,
    }
  }

  if (!parseOffice) {
    return {
      content: '',
      fileType: 'document',
      header: `[File: ${fileName} | officeparser API not found]`,
      truncated: false,
    }
  }

  const fileType = ext === '.xlsx' || ext === '.xls' || ext === '.ods'
    ? 'spreadsheet'
    : ext === '.pptx' || ext === '.ppt' || ext === '.odp'
    ? 'presentation'
    : 'document'

  try {
    const result = await parseOffice(filePath)

    // officeparser v6 returns AST, earlier versions return string
    let text = ''
    if (typeof result === 'string') {
      text = result
    } else if (result && typeof result === 'object') {
      // AST format — convert to text
      text = astToText(result)
    }

    if (!text || text.trim().length === 0) {
      // PDF might be a scanned image
      if (ext === '.pdf') {
        return {
          content: '',
          fileType,
          header: `[PDF: ${fileName} | Size: ${fileSize} | No extractable text (possibly scanned/image-based)]`,
          truncated: false,
        }
      }
      return {
        content: '',
        fileType,
        header: `[File: ${fileName} | Size: ${fileSize} | No text content found]`,
        truncated: false,
      }
    }

    const truncated = text.length > MAX_EXTRACT_CHARS
    const content = truncated ? text.slice(0, MAX_EXTRACT_CHARS) + '\n\n[Content truncated]' : text

    const typeLabel = ext === '.pdf' ? 'PDF'
      : ext === '.docx' || ext === '.doc' ? 'Word'
      : ext === '.pptx' || ext === '.ppt' ? 'PPT'
      : ext === '.xlsx' || ext === '.xls' ? 'Excel'
      : ext.toUpperCase().slice(1)

    return {
      content,
      fileType,
      header: `[${typeLabel}: ${fileName} | Size: ${fileSize}${truncated ? ' | Truncated' : ''}]`,
      truncated,
    }
  } catch (err: any) {
    const msg = err.message || ''

    // Password-protected detection
    if (msg.includes('password') || msg.includes('encrypt') || msg.includes('protected')) {
      return {
        content: '',
        fileType,
        header: `[File: ${fileName} | Password-protected, cannot read]`,
        truncated: false,
      }
    }

    return {
      content: '',
      fileType,
      header: `[File: ${fileName} | Parse failed: ${msg.slice(0, 100)}]`,
      truncated: false,
    }
  }
}

// ---------------------------------------------------------------------------
// AST to text conversion (officeparser v6)
// ---------------------------------------------------------------------------

function astToText(ast: any): string {
  if (!ast) return ''

  // If it's already a string, return it
  if (typeof ast === 'string') return ast

  // If it has a 'text' property
  if (ast.text) return ast.text

  // If it's an array, process each element
  if (Array.isArray(ast)) {
    return ast.map(item => astToText(item)).filter(Boolean).join('\n')
  }

  // If it has 'content' or 'children'
  const parts: string[] = []
  if (ast.content) {
    if (typeof ast.content === 'string') {
      parts.push(ast.content)
    } else if (Array.isArray(ast.content)) {
      parts.push(ast.content.map((c: any) => astToText(c)).filter(Boolean).join('\n'))
    }
  }
  if (ast.children) {
    if (Array.isArray(ast.children)) {
      parts.push(ast.children.map((c: any) => astToText(c)).filter(Boolean).join('\n'))
    }
  }

  // Handle specific node types
  if (ast.type === 'heading' && ast.level) {
    const prefix = '#'.repeat(ast.level)
    return `${prefix} ${parts.join(' ')}`
  }
  if (ast.type === 'table' && ast.rows) {
    return formatTable(ast.rows)
  }
  if (ast.type === 'list-item') {
    return `- ${parts.join(' ')}`
  }

  // Handle pages/slides
  if (ast.pages && Array.isArray(ast.pages)) {
    return ast.pages.slice(0, MAX_PDF_PAGES).map((page: any, i: number) => {
      const text = astToText(page)
      return text ? `--- Page ${i + 1} ---\n${text}` : ''
    }).filter(Boolean).join('\n\n')
  }
  if (ast.slides && Array.isArray(ast.slides)) {
    return ast.slides.map((slide: any, i: number) => {
      const text = astToText(slide)
      return text ? `--- Slide ${i + 1} ---\n${text}` : ''
    }).filter(Boolean).join('\n\n')
  }
  if (ast.sheets && Array.isArray(ast.sheets)) {
    return ast.sheets.map((sheet: any) => {
      const name = sheet.name || 'Sheet'
      const text = astToText(sheet)
      return text ? `--- ${name} ---\n${text}` : ''
    }).filter(Boolean).join('\n\n')
  }

  return parts.join('\n')
}

function formatTable(rows: any[]): string {
  if (!Array.isArray(rows) || rows.length === 0) return ''

  const textRows = rows.slice(0, MAX_SPREADSHEET_ROWS).map((row: any) => {
    if (Array.isArray(row)) {
      return row.map((cell: any) => String(cell?.text || cell?.content || cell || '').trim())
    }
    if (row.cells) {
      return row.cells.map((cell: any) => String(cell?.text || cell?.content || cell || '').trim())
    }
    return [String(row)]
  })

  if (textRows.length === 0) return ''

  // Markdown table if narrow enough, otherwise CSV
  const maxCols = Math.max(...textRows.map(r => r.length))
  if (maxCols <= 8) {
    const header = textRows[0]
    const separator = header.map(() => '---')
    const lines = [
      `| ${header.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...textRows.slice(1).map(row => `| ${row.join(' | ')} |`),
    ]
    return lines.join('\n')
  }

  // CSV for wide tables
  return textRows.map(row => row.join(',')).join('\n')
}

// ---------------------------------------------------------------------------
// Images — metadata only (no OCR in MVP)
// ---------------------------------------------------------------------------

function extractImageInfo(
  filePath: string,
  fileName: string,
  fileSize: string,
  ext: string,
): ExtractionResult {
  return {
    content: '',
    fileType: 'image',
    header: `[Image: ${fileName} | Format: ${ext.slice(1).toUpperCase()} | Size: ${fileSize}]`,
    truncated: false,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
