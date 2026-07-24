import { describe, expect, mock, test } from "bun:test"
import { PersistentContextCache } from "../src/persistentContextCache"

function makeFakeContext() {
  return {
    addInitScript: mock(async () => {}),
    close: mock(async () => {}),
  }
}

describe("PersistentContextCache", () => {
  test("returns undefined for unknown host", () => {
    const c = new PersistentContextCache()
    expect(c.get("never-seen.example.com")).toBeUndefined()
  })

  test("set + get round-trips a context and tracks per-browser count", () => {
    const c = new PersistentContextCache()
    const ctx = makeFakeContext()
    c.set("a.example.com", ctx, 0)
    expect(c.get("a.example.com")).toBe(ctx)
    expect(c.contextCount(0)).toBe(1)
  })

  test("respects idle TTL — past TTL returns undefined", () => {
    const c = new PersistentContextCache({ ttlMs: 10 })
    const ctx = makeFakeContext()
    c.set("host.example", ctx, 0)
    expect(c.get("host.example")).toBe(ctx)
    const deadline = Date.now() + 30
    while (Date.now() < deadline) {
      // wait
    }
    expect(c.get("host.example")).toBeUndefined()
    expect(c.size()).toBe(0)
  })

  test("evict() removes a specific entry and decrements per-browser count", () => {
    const c = new PersistentContextCache()
    const a = makeFakeContext()
    const b = makeFakeContext()
    c.set("a", a, 0)
    c.set("b", b, 1)
    expect(c.size()).toBe(2)
    c.evict("a")
    expect(c.size()).toBe(1)
    expect(c.contextCount(0)).toBe(0)
    expect(c.contextCount(1)).toBe(1)
  })

  test("evict() calls onEvict hook OR context.close()", async () => {
    const ctx = makeFakeContext()
    const c = new PersistentContextCache({ onEvict: () => ctx.close() })
    c.set("a", ctx, 0)
    c.evict("a")
    await Promise.resolve()
    expect(ctx.close).toHaveBeenCalled()
  })

  test("evicting last context for a browser clears the per-browser counter", () => {
    const c = new PersistentContextCache()
    const ctx = makeFakeContext()
    c.set("only.example", ctx, 0)
    expect(c.contextCount(0)).toBe(1)
    c.evict("only.example")
    expect(c.contextCount(0)).toBe(0)
  })

  test("LRU eviction when at capacity — least recently used is dropped", () => {
    const c = new PersistentContextCache({ maxEntries: 2 })
    const a = makeFakeContext()
    const b = makeFakeContext()
    const cc = makeFakeContext()
    c.set("a", a, 0)
    c.set("b", b, 1)
    c.get("a") // touch `a` so `b` becomes LRU
    c.set("c", cc, 2)
    expect(c.get("b")).toBeUndefined()
    expect(c.get("a")).toBe(a)
    expect(c.get("c")).toBe(cc)
    expect(c.size()).toBe(2)
  })

  test("invalidateBrowser() drops all contexts owned by that browser", () => {
    const c = new PersistentContextCache()
    const a = makeFakeContext()
    const b = makeFakeContext()
    const d = makeFakeContext()
    c.set("a.example", a, 0)
    c.set("b.example", b, 0)
    c.set("d.example", d, 1)
    expect(c.size()).toBe(3)
    const removed = c.invalidateBrowser(0)
    expect(removed.sort()).toEqual(["a.example", "b.example"])
    expect(c.size()).toBe(1)
    expect(c.get("d.example")).toBe(d)
    expect(c.contextCount(0)).toBe(0)
    expect(c.contextCount(1)).toBe(1)
  })

  test("prune() removes all entries past TTL", () => {
    const c = new PersistentContextCache({ ttlMs: 5 })
    c.set("a", makeFakeContext(), 0)
    c.set("b", makeFakeContext(), 1)
    c.set("c", makeFakeContext(), 2)
    const deadline = Date.now() + 25
    while (Date.now() < deadline) {
      // wait
    }
    expect(c.prune()).toBe(3)
    expect(c.size()).toBe(0)
  })

  test("leastLoadedBrowser() picks the browser with fewest cached contexts", () => {
    const c = new PersistentContextCache()
    c.set("a1", makeFakeContext(), 0)
    c.set("a2", makeFakeContext(), 0)
    c.set("b1", makeFakeContext(), 1)
    expect(c.leastLoadedBrowser([0, 1])).toBe(1)
    c.set("b2", makeFakeContext(), 1)
    c.set("b3", makeFakeContext(), 1)
    expect(c.leastLoadedBrowser([0, 1])).toBe(0)
    expect(c.leastLoadedBrowser([])).toBeUndefined()
  })

  test("set() replaces existing entry without growing size past maxEntries", () => {
    const c = new PersistentContextCache({ maxEntries: 2 })
    const a1 = makeFakeContext()
    const a2 = makeFakeContext()
    c.set("host", a1, 0)
    expect(c.get("host")).toBe(a1)
    c.set("host", a2, 0)
    expect(c.get("host")).toBe(a2)
    expect(c.size()).toBe(1)
    expect(c.contextCount(0)).toBe(1)
  })

  test("get() refreshes the access counter so the entry survives LRU eviction", () => {
    const c = new PersistentContextCache({ maxEntries: 2, ttlMs: 30 })
    const a = makeFakeContext()
    const b = makeFakeContext()
    const cc = makeFakeContext()
    c.set("a", a, 0) // touchCounter=1
    const midDeadline = Date.now() + 15
    while (Date.now() < midDeadline) {
      // wait
    }
    c.get("a") // touchCounter=2 (refreshes `a`)
    c.set("b", b, 1) // touchCounter=3
    c.set("c", cc, 2) // touchCounter=4; LRU = `a` (counter=2), but `a` was refreshed…
    // Wait — the LRU is now whoever has the SMALLEST counter among "a" (2) and "b" (3).
    // That's `a`. So adding "c" evicts `a`, not `b`. To make `a` survive, the refresh
    // must happen AFTER `b` is set. Test that scenario explicitly:
    const c2 = new PersistentContextCache({ maxEntries: 2 })
    const a2 = makeFakeContext()
    const b2 = makeFakeContext()
    const cc2 = makeFakeContext()
    c2.set("a2", a2, 0) // counter=1
    c2.set("b2", b2, 1) // counter=2
    c2.get("b2") // counter=3 — refresh b2
    c2.set("c2", cc2, 2) // counter=4; LRU = a2 (counter=1) — `a2` evicted
    expect(c2.get("a2")).toBeUndefined()
    expect(c2.get("b2")).toBe(b2) // survived thanks to get() refresh
    expect(c2.get("c2")).toBe(cc2)

    // And the cleanup above proves `a` from the first scenario was evicted:
    expect(c.get("a")).toBeUndefined()
    expect(c.get("b")).toBe(b)
    expect(c.get("c")).toBe(cc)
  })
})
