import type { BrowserHandle, PersistentBrowserContext } from "@trawl/browser"
import type { Cookie, SessionData, TierResult } from "@trawl/types"
import { solvePageCaptchas } from "../solvers"
import { normalizeSameSite, toCookies } from "../utils/cookies"
import { isBlocked, isBrowserErrorPage, isCloudflarePage } from "../utils/detect"
import { normalizeHtml } from "../utils/html"
import { captureResponse, isTextContentType, type MinimalResponse } from "../utils/response"
import type { RouteLike } from "../utils/sanitize"
import { routeContinueOverrides } from "../utils/sanitize"

export interface Tier2Result extends TierResult {
  tier: 2
  html?: string
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
  cookies?: Cookie[]
  statusCode?: number
  captchasSolved?: string[]
}

export async function runTier2(
  url: string,
  handle: BrowserHandle,
  session: SessionData,
  maxTimeout: number,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
  // Optional — when provided by the orchestrator, Tier 2 reuses a warm per-host
  // browser context on repeat visits. Cached contexts already hold cf_clearance
  // cookies from the prior solve, so we skip the Redis round-trip and cookie
  // re-injection entirely.
  deps?: {
    acquireContext?(handleId: number, hostname: string): Promise<PersistentBrowserContext | undefined>
    saveContext?(handleId: number, hostname: string, context: PersistentBrowserContext): Promise<void>
    releaseContext?(handleId: number, hostname: string): void
  },
  hostname?: string,
): Promise<Tier2Result> {
  const start = Date.now()

  // Pick the context: persistent cache hit → reuse; otherwise fall back to the
  // pool's shared context. The shared context still works (existing behavior)
  // — only the persistent cache path is new.
  let activeContext = handle.context
  let contextFromCache = false
  if (deps?.acquireContext && hostname) {
    const cached = await deps.acquireContext(handle.id, hostname)
    if (cached) {
      activeContext = cached
      contextFromCache = true
    }
  }

  const page = await activeContext.newPage()

  try {
    // addCookies replaces cookies by name+domain+path, so no need to clearCookies first.
    // Keeping the context's CF cookies (cf_clearance, __cf_bm) intact means CF sees a
    // browser with history, which speeds up challenge evaluation on the next Tier 3 run.
    // Skip the Redis→cookie re-injection on cache hits — the persistent context
    // already carries cookies from its prior solve.
    if (!contextFromCache) {
      await activeContext.addCookies(
        session.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: normalizeSameSite(c.sameSite),
        })),
      )
    }

    await page.setExtraHTTPHeaders({ "User-Agent": session.userAgent })

    if ((extraHeaders && Object.keys(extraHeaders).length > 0) || method === "POST") {
      await page.route(url, (route: RouteLike) => {
        route.continue(routeContinueOverrides(route, extraHeaders, method, body))
      })
    }

    let statusCode = 200
    const mainResponseHolder: { value?: MinimalResponse } = {}
    page.on("response", (res: MinimalResponse) => {
      if (res.url() === url) {
        statusCode = res.status()
        if (!mainResponseHolder.value) mainResponseHolder.value = res
      }
    })

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: maxTimeout })
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})

    const html = await page.content()

    if (isBrowserErrorPage(html)) {
      return {
        tier: 2,
        status: "error",
        durationMs: Date.now() - start,
        reason: "browser network error (about:neterror)",
      }
    }

    if (isCloudflarePage(html, {})) {
      return { tier: 2, status: "blocked", durationMs: Date.now() - start, reason: "session-expired" }
    }

    if (isBlocked(statusCode, html)) {
      return { tier: 2, status: "blocked", durationMs: Date.now() - start, reason: `http-${statusCode}` }
    }

    // Attempt to solve any embedded captcha widgets (Turnstile, reCAPTCHA, hCaptcha).
    // Pages that load cleanly via session cache may still have in-page challenge widgets.
    const solveRemaining = maxTimeout - (Date.now() - start)
    let captchasSolved: string[] = []
    if (solveRemaining > 5000) {
      const result = await solvePageCaptchas(page, solveRemaining).catch(() => ({ attempted: [], solved: [] }))
      captchasSolved = result.solved
    }

    const cookies: Cookie[] = toCookies(await activeContext.cookies())

    const captured = await captureResponse(mainResponseHolder.value)

    // On success, register this context in the persistent cache so the next
    // visit to this hostname skips cookie loading entirely. Skip if it was
    // already served from the cache (no need to re-register the same context).
    if (!contextFromCache && deps?.saveContext && hostname && cookies.length > 0) {
      await deps.saveContext(handle.id, hostname, activeContext).catch(() => {
        // Caching is best-effort; the request already succeeded.
      })
    }

    return {
      tier: 2,
      status: "success",
      durationMs: Date.now() - start,
      // For HTML/text content-types, `html` is the rendered DOM. For binary, leave
      // empty so /scrape consumers know to use `body`/`contentType`.
      html: !captured.contentType || isTextContentType(captured.contentType) ? normalizeHtml(html) : "",
      ...captured,
      cookies,
      statusCode,
      captchasSolved: captchasSolved.length > 0 ? captchasSolved : undefined,
    }
  } catch (err) {
    return {
      tier: 2,
      status: "error",
      durationMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    }
  } finally {
    await page.close().catch(() => {})
  }
}
