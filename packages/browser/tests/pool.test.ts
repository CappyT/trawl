import { afterEach, describe, expect, test } from "bun:test"
import { BrowserPool } from "../src/pool"

const pools: BrowserPool[] = []

const createPool = (opts: ConstructorParameters<typeof BrowserPool>[0]): BrowserPool => {
  const pool = new BrowserPool(opts)
  pools.push(pool)
  return pool
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()))
})

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for condition")
}

type MockBrowser = {
  closed: boolean
  isConnected: () => boolean
  close: () => Promise<void>
}
type MockContext = {
  closed: boolean
  pages: () => unknown[]
  close: () => Promise<void>
}

function makeFactory() {
  const browsers: MockBrowser[] = []
  const contexts: MockContext[] = []
  const factory = async () => {
    const browser: MockBrowser = {
      closed: false,
      isConnected() {
        return !this.closed
      },
      async close() {
        this.closed = true
      },
    }
    const context: MockContext = {
      closed: false,
      pages: () => [],
      async close() {
        this.closed = true
      },
    }
    browsers.push(browser)
    contexts.push(context)
    return { browser, context }
  }
  return { factory, browsers, contexts }
}

describe("BrowserPool recycling", () => {
  test("restarts the browser after the temporary context threshold", async () => {
    const { factory, browsers, contexts } = makeFactory()

    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 2,
      browserFactory: factory,
    })

    await pool.init()

    const first = await pool.acquire("example.com")
    first.noteTemporaryContext?.("tier3 fresh context")
    pool.release(first.id)

    expect(pool.getStats().restarts).toBe(0)
    expect(pool.getStats().available).toBe(1)

    const second = await pool.acquire("example.com")
    second.noteTemporaryContext?.("tier3 fresh context")
    pool.release(second.id)

    await waitFor(() => pool.getStats().restarts === 1)

    expect(contexts[0].closed).toBe(true)
    expect(browsers[0].closed).toBe(true)
    expect(pool.getStats().available).toBe(1)
    expect(browsers).toHaveLength(2)
  })

  test("noteTemporaryContext is no-op when recycleAfterTemporaryContexts=0", async () => {
    const { factory, browsers } = makeFactory()

    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 0, // disabled
      browserFactory: factory,
    })

    await pool.init()

    // Hammer the pool with noteTemporaryContext — should never trigger recycle.
    for (let i = 0; i < 20; i++) {
      const handle = await pool.acquire("example.com")
      handle.noteTemporaryContext?.("tier3 blocked")
      pool.release(handle.id)
    }

    // No recycle should have happened — only the initial browser exists.
    expect(pool.getStats().restarts).toBe(0)
    expect(browsers).toHaveLength(1)
  })

  test("successful acquires do NOT trigger recycle (recycle driven by orchestrator, not pool)", async () => {
    // Documents the contract: the pool itself does NOT decide when to recycle based
    // on temporary-context count. The orchestrator decides (by calling
    // noteTemporaryContext only on blocked/needs-js outcomes). This test verifies
    // that the pool, given N successful acquires, never recycles on its own.
    const { factory, browsers } = makeFactory()

    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 2,
      browserFactory: factory,
    })

    await pool.init()

    // Simulate 10 "successful" Tier 3 attempts that the orchestrator does NOT flag.
    // (No noteTemporaryContext calls.) Pool should never recycle.
    for (let i = 0; i < 10; i++) {
      const handle = await pool.acquire("example.com")
      pool.release(handle.id)
    }

    expect(pool.getStats().restarts).toBe(0)
    expect(browsers).toHaveLength(1)
  })

  test("contentProcesses option is stored without crashing", async () => {
    // We can't easily test that Camoufox is called with the right `prefs` block
    // without mocking the Camoufox module itself. This test verifies that the
    // option round-trips through the constructor without error.
    const { factory } = makeFactory()

    const pool = createPool({
      poolSize: 1,
      contentProcesses: 4,
      browserFactory: factory,
    })

    await pool.init()
    expect(pool.getStats().total).toBe(1)
  })
})
