import { BrowserPool, type PersistentBrowserContext, PersistentContextCache, SessionCache } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import type { SessionData } from "@trawl/types"
import {
  ACQUIRE_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
  CONTENT_PROCESSES,
  LAUNCH_TIMEOUT_MS,
  POOL_SIZE,
  proxyPool,
  RECYCLE_AFTER_TEMPORARY_CONTEXTS,
  REDIS_URL,
  residentialProxyPool,
  SESSION_TTL,
  STALL_TIMEOUT_MS,
} from "./config"

const state: {
  pool?: BrowserPool
  sessionCache?: SessionCache
  persistentContextCache?: PersistentContextCache
} = {}

export const getPool = () => state.pool

export const initPool = async (): Promise<void> => {
  try {
    state.sessionCache = new SessionCache({
      redisUrl: REDIS_URL,
      ttlSeconds: SESSION_TTL,
    })
    console.log("[api] session cache connected  (Tier 2 fast-path enabled)")
  } catch (err) {
    console.warn("[api] session cache unavailable — Tier 2 disabled:", err instanceof Error ? err.message : err)
  }

  state.pool = new BrowserPool({
    poolSize: POOL_SIZE,
    acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
    recycleAfterTemporaryContexts: RECYCLE_AFTER_TEMPORARY_CONTEXTS,
    contentProcesses: CONTENT_PROCESSES,
    stallAfterMs: STALL_TIMEOUT_MS,
    closeTimeoutMs: CLOSE_TIMEOUT_MS,
    launchTimeoutMs: LAUNCH_TIMEOUT_MS,
  })
  await state.pool.init()
  state.pool.startHealthCheck()

  state.persistentContextCache = new PersistentContextCache({
    maxEntries: 20,
    ttlMs: 10 * 60 * 1000,
  })

  console.log(`[api] ready — all ${POOL_SIZE} browser${POOL_SIZE === 1 ? "" : "s"} warm`)
}

export const getDeps = (): OrchestratorDeps => {
  if (!state.pool) throw new Error("pool not ready")
  const p = state.pool
  const sc = state.sessionCache
  const pcc = state.persistentContextCache
  return {
    acquireBrowser: (d: string, budgetMs?: number) => p.acquire(d, budgetMs),
    releaseBrowser: (id: number, lease?: number) => p.release(id, lease),
    loadSession: (d: string) => (sc ? sc.load(d).catch(() => undefined) : Promise.resolve(undefined)),
    saveSession: (d: string, data: SessionData) => (sc ? sc.save(d, data).catch(() => {}) : Promise.resolve()),
    invalidateSession: (d: string) => (sc ? sc.invalidate(d).catch(() => {}) : Promise.resolve()),
    proxyPool,
    residentialProxyPool,
    acquireContext: async (_handleId: number, hostname: string) => pcc?.get(hostname),
    saveContext: async (handleId: number, hostname: string, context: PersistentBrowserContext) => {
      if (pcc) pcc.set(hostname, context, handleId)
    },
    releaseContext: (_handleId: number, hostname: string) => {
      pcc?.get(hostname)
    },
    invalidateContext: async (hostname: string) => {
      pcc?.evict(hostname)
    },
  }
}
