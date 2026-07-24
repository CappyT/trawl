// Per-host browser contexts keep clearance state warm between requests.
export interface PersistentBrowserContext {
  addInitScript(script: () => void): Promise<void>
  close?: () => Promise<void>
}

interface PersistentBrowser {
  newContext(options: { viewport: null }): Promise<PersistentBrowserContext>
}

interface CacheEntry {
  context: PersistentBrowserContext
  browserId: number
  lastUsed: number
  // Monotonic access counter — increments on every set/get. Used for LRU
  // ordering because Date.now() can tie within a single millisecond when
  // operations happen back-to-back.
  lastTouched: number
  createdAt: number
}

export interface PersistentContextCacheOpts {
  // Maximum total cached contexts. LRU eviction kicks in past this limit.
  maxEntries?: number
  // Idle TTL — entries unused for longer than this are pruned.
  ttlMs?: number
  // Hook called when a context is evicted (cache miss + LRU + manual invalidate).
  // Used to close the underlying Playwright context.
  onEvict?: (context: PersistentBrowserContext) => void
}

export class PersistentContextCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly onEvict?: (context: PersistentBrowserContext) => void
  // Per-browser context count for fair load distribution when allocating new contexts.
  private readonly contextCountByBrowser = new Map<number, number>()
  // Monotonic counter for LRU ordering — see CacheEntry.lastTouched.
  private touchCounter = 0

  constructor(opts: PersistentContextCacheOpts = {}) {
    this.maxEntries = opts.maxEntries ?? 20
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000 // 10 minutes idle
    this.onEvict = opts.onEvict
  }

  // Returns a cached context for `hostname`, or undefined if none exists / expired.
  // Touches the lastUsed timestamp so LRU picks up the access.
  get(hostname: string) {
    const entry = this.entries.get(hostname)
    if (!entry) return
    if (Date.now() - entry.lastUsed > this.ttlMs) {
      this.evict(hostname)
      return
    }
    entry.lastUsed = Date.now()
    entry.lastTouched = ++this.touchCounter
    return entry.context
  }

  // Register a fresh context for `hostname`, owned by `browserId`. If an entry
  // already exists it is evicted first (caller is replacing it).
  set(hostname: string, context: PersistentBrowserContext, browserId: number): void {
    const existing = this.entries.get(hostname)
    if (existing && existing.context !== context) {
      this.evictEntry(existing, hostname)
    }
    if (this.entries.size >= this.maxEntries && !this.entries.has(hostname)) {
      const lru = this.findLRU()
      if (lru && lru !== hostname) this.evict(lru)
    }
    this.entries.set(hostname, {
      context,
      browserId,
      lastUsed: Date.now(),
      lastTouched: ++this.touchCounter,
      createdAt: Date.now(),
    })
    this.contextCountByBrowser.set(browserId, (this.contextCountByBrowser.get(browserId) ?? 0) + 1)
  }

  // Remove a specific entry. Closes the context.
  evict(hostname: string): void {
    const entry = this.entries.get(hostname)
    if (!entry) return
    this.evictEntry(entry, hostname)
  }

  private evictEntry(entry: CacheEntry, hostname: string): void {
    this.entries.delete(hostname)
    const count = this.contextCountByBrowser.get(entry.browserId) ?? 1
    if (count <= 1) this.contextCountByBrowser.delete(entry.browserId)
    else this.contextCountByBrowser.set(entry.browserId, count - 1)
    if (this.onEvict) {
      try {
        this.onEvict(entry.context)
      } catch {
        // closing can throw if the browser is already gone; ignore
      }
    } else {
      entry.context.close?.().catch(() => {})
    }
  }

  // Drop all contexts owned by a specific browser (called when the browser
  // restarts). Returns the hostnames that were invalidated.
  invalidateBrowser(browserId: number): string[] {
    const removed: string[] = []
    for (const [host, entry] of this.entries) {
      if (entry.browserId === browserId) {
        removed.push(host)
      }
    }
    for (const host of removed) {
      this.evict(host)
    }
    return removed
  }

  // Find the hostname with the smallest lastTouched (LRU eviction candidate).
  // Uses the monotonic counter so back-to-back operations don't tie.
  private findLRU() {
    let oldest: string | undefined
    let oldestTouched = Infinity
    for (const [host, entry] of this.entries) {
      if (entry.lastTouched < oldestTouched) {
        oldestTouched = entry.lastTouched
        oldest = host
      }
    }
    return oldest
  }

  // Periodic cleanup of entries past their TTL. Returns count of removed entries.
  prune(): number {
    const now = Date.now()
    const toRemove: string[] = []
    for (const [host, entry] of this.entries) {
      if (now - entry.lastUsed > this.ttlMs) toRemove.push(host)
    }
    for (const host of toRemove) this.evict(host)
    return toRemove.length
  }

  size(): number {
    return this.entries.size
  }

  // Pick the browser with the fewest cached contexts (for fair load distribution
  // when allocating a new persistent context). Pass the set of available
  // browser IDs; undefined if the list is empty.
  leastLoadedBrowser(availableBrowserIds: number[]) {
    if (availableBrowserIds.length === 0) return
    let best: number | undefined
    let bestCount = Infinity
    for (const id of availableBrowserIds) {
      const count = this.contextCountByBrowser.get(id) ?? 0
      if (count < bestCount) {
        bestCount = count
        best = id
      }
    }
    return best
  }

  // For tests / observability
  contextCount(browserId: number): number {
    return this.contextCountByBrowser.get(browserId) ?? 0
  }
}

// Helper: create a fresh context with TRAWL's init scripts applied. Re-exported
// here so callers don't need to import from pool.ts directly when wiring the
// cache.
export const createPersistentContext = async (browser: PersistentBrowser): Promise<PersistentBrowserContext> => {
  const context = await browser.newContext({ viewport: null })
  await context.addInitScript(() => {
    window.onerror = () => true
    window.addEventListener(
      "unhandledrejection",
      (e: PromiseRejectionEvent) => {
        e.preventDefault()
      },
      true,
    )
    const _orig = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      const r = _orig.call(this, init)
      Object.defineProperty(this, "shadowRootUnl", { configurable: true, value: r })
      return r
    }
  })
  return context
}
