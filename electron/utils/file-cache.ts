import fs from 'fs'

interface CachedFile {
  content: string
  mtimeMs: number
  sizeBytes: number
}

const MAX_CACHE_ENTRIES = 200
const MAX_CACHEABLE_SIZE = 5 * 1024 * 1024  // 5MB

/**
 * Simple file read cache with mtime invalidation.
 * Files are re-read only if their mtime has changed.
 * FIFO eviction when cache exceeds MAX_CACHE_ENTRIES.
 */
class FileReadCache {
  private cache = new Map<string, CachedFile>()

  read(filePath: string): string | null {
    try {
      const stats = fs.statSync(filePath)
      if (!stats.isFile() || stats.size > MAX_CACHEABLE_SIZE) return null

      const cached = this.cache.get(filePath)
      if (cached && cached.mtimeMs === stats.mtimeMs && cached.sizeBytes === stats.size) {
        return cached.content
      }

      const content = fs.readFileSync(filePath, 'utf-8')
      this.set(filePath, content, stats.mtimeMs, stats.size)
      return content
    } catch {
      return null
    }
  }

  private set(filePath: string, content: string, mtimeMs: number, sizeBytes: number): void {
    // Delete first to update insertion order (LRU-like eviction)
    this.cache.delete(filePath)
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }
    this.cache.set(filePath, { content, mtimeMs, sizeBytes })
  }

  /** Invalidate a specific path (call after writes). */
  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  /** Clear entire cache. */
  clear(): void {
    this.cache.clear()
  }
}

export const fileReadCache = new FileReadCache()
