import type { BrowserHandle } from "@trawl/browser"
import { FINGERPRINT } from "@trawl/browser"
import type { Cookie, TierResult } from "@trawl/types"
import { solvePageCaptchas } from "../solvers"
import { waitForChallengeResolution } from "../utils/challengeWait"
import { toCookies } from "../utils/cookies"
import {
  detectChallengeType,
  hasImpervaChallenge,
  isBlocked,
  isBrowserErrorPage,
  isCloudflarePage,
} from "../utils/detect"
import { normalizeHtml } from "../utils/html"
import { waitForImpervaResolution } from "../utils/impervaWait"
import { isHardNetworkFailure } from "../utils/network"
import { captureResponse, isTextContentType, type MinimalResponse } from "../utils/response"
import type { RouteLike } from "../utils/sanitize"
import { routeContinueOverrides } from "../utils/sanitize"

export interface Tier4Result extends TierResult {
  tier: 4
  html?: string
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
  cookies?: Cookie[]
  userAgent?: string
  statusCode?: number
  captchasSolved?: string[]
}

export async function runTier4(
  url: string,
  handle: BrowserHandle,
  maxTimeout: number,
  proxyUrl: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
): Promise<Tier4Result> {
  const start = Date.now()

  // Create an isolated context routed through the proxy.
  // Proxies must be set at context creation time in Playwright — they cannot be
  // applied per-request. We create a fresh context here and close it when done,
  // leaving the pool's shared context untouched.
  const state: { proxyContext?: Awaited<ReturnType<typeof handle.browser.newContext>> } = {}

  try {
    // Camoufox handles fingerprinting at the C++ level — only the proxy needs to
    // be set at context creation (Playwright requires proxy at context init time).
    const proxyContext = await handle.browser.newContext({
      proxy: { server: proxyUrl },
      viewport: null,
    })
    state.proxyContext = proxyContext
    await proxyContext.addInitScript(() => {
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

    const page = await proxyContext.newPage()

    if ((extraHeaders && Object.keys(extraHeaders).length > 0) || method === "POST") {
      await page.route(url, (route: RouteLike) => {
        route.continue(routeContinueOverrides(route, extraHeaders, method, body))
      })
    }

    let statusCode = 200
    const mainResponseHolder: { value?: MinimalResponse } = {}
    page.on("response", (res: MinimalResponse) => {
      try {
        if (res.url() === url || res.url().startsWith(url.replace(/\/$/, ""))) {
          statusCode = res.status()
          if (!mainResponseHolder.value) mainResponseHolder.value = res
        }
      } catch {}
    })

    const gotoErr = await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(maxTimeout, 30_000),
      })
      .catch((e: Error) => e)

    if (isHardNetworkFailure(gotoErr)) {
      return { tier: 4, status: "error", durationMs: Date.now() - start, reason: gotoErr.message.split("\n")[0] }
    }

    const remaining = maxTimeout - (Date.now() - start)
    const peekHtml = await page.content().catch(() => "")
    const challengeType = detectChallengeType(peekHtml)
    const resolution =
      challengeType === "imperva"
        ? await waitForImpervaResolution(page, remaining, url)
        : await waitForChallengeResolution(page, remaining, url)

    if (resolution !== "ok") {
      return {
        tier: 4,
        status: resolution === "ip-blocked" ? "blocked" : "timeout",
        durationMs: Date.now() - start,
        reason:
          resolution === "ip-blocked"
            ? "proxy-ip-blocked"
            : challengeType === "imperva"
              ? "imperva-challenge-timeout"
              : "cloudflare-challenge-timeout",
      }
    }

    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})

    // Attempt to solve any embedded captcha widgets on the page (Turnstile, reCaptcha, hCaptcha) —
    // same as Tier 3. Sites that reach Tier 4 for IP reputation can still have an in-page widget.
    const solveRemaining = maxTimeout - (Date.now() - start)
    let captchasSolved: string[] = []
    if (solveRemaining > 5000) {
      const solveResult = await solvePageCaptchas(page, solveRemaining).catch(() => ({ attempted: [], solved: [] }))
      captchasSolved = solveResult.solved
    }

    const html = await page.content()

    if (html.length < 100) {
      return { tier: 4, status: "error", durationMs: Date.now() - start, reason: "page returned empty content" }
    }

    if (isBrowserErrorPage(html)) {
      return {
        tier: 4,
        status: "error",
        durationMs: Date.now() - start,
        reason: "browser network error (about:neterror)",
      }
    }

    if (isCloudflarePage(html, {})) {
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "cloudflare-persistent",
      }
    }

    if (hasImpervaChallenge(html)) {
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "imperva-persistent",
      }
    }

    if (isBlocked(statusCode, html)) {
      return { tier: 4, status: "blocked", durationMs: Date.now() - start, reason: `http-${statusCode}` }
    }

    const cookies: Cookie[] = toCookies(await proxyContext.cookies())

    const captured = await captureResponse(mainResponseHolder.value)

    return {
      tier: 4,
      status: "success",
      durationMs: Date.now() - start,
      html: !captured.contentType || isTextContentType(captured.contentType) ? normalizeHtml(html) : "",
      ...captured,
      cookies,
      userAgent: await page.evaluate(() => navigator.userAgent).catch(() => FINGERPRINT.userAgent),
      statusCode,
      captchasSolved: captchasSolved.length > 0 ? captchasSolved : undefined,
    }
  } catch (err) {
    return {
      tier: 4,
      status: "error",
      durationMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    }
  } finally {
    // Same timeout-bounded close as tier3 — see comment there.
    if (state.proxyContext) {
      await Promise.race([state.proxyContext.close(), new Promise<void>((resolve) => setTimeout(resolve, 5000))]).catch(
        () => {},
      )
    }
  }
}
