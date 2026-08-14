// DDoS-Guard JS-challenge wait — mirrors impervaWait.ts's cookie polling loop.
// DDoS-Guard serves a ~900-byte interstitial that loads
// /.well-known/ddos-guard/js-challenge/{index,view}.js plus check.ddos-guard.net/check.js,
// says "Checking your browser before accessing", and reloads into the real content once
// its script has set the __ddg* cookies. Like Imperva's sensor challenge, a real browser
// running real JS satisfies it — there is no obfuscation to reimplement, so we just wait
// for the interstitial to go away.
//
// Before this existed, DDoS-Guard was folded into isCloudflarePage() and handled by
// waitForChallengeResolution(), which polls for cf_clearance and Cloudflare DOM markers
// that a DDoS-Guard page never emits. That burned the entire timeout and then reported
// the failure as "cloudflare-persistent".
//
// Known risk: DDoS-Guard also has a checkbox ("I am not a robot") variant on some sites.
// This wait does not drive it — the JS-only interstitial is what Anna's Archive serves,
// which is what this was written and validated against. A checkbox page will fall through
// to "timeout" rather than being mis-reported as solved.

import type { Page } from "patchright"
import { hasDdosGuardChallenge } from "./detect"

// Two retries is enough to tell a missed auto-reload from a wall that keeps coming
// back. Beyond that the browser is being held for nothing.
const MAX_RENAVIGATIONS = 2

// page.content() / context.cookies() can hang rather than reject when the browser
// transport wedges — .catch() does not bound that, and a hang here holds a pooled
// browser past the deadline. This service has already been bitten by pool entries
// pinned by unbounded awaits, so every Playwright call in the loop goes through here.
function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((r) => setTimeout(() => r(fallback), ms)),
  ])
}

export async function waitForDdosGuardResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
): Promise<"ok" | "ip-blocked" | "timeout"> {
  // Never exceed the caller's budget. impervaWait/akamaiWait use Math.max(timeoutMs,
  // 30_000), which silently extends a tier past the time the request asked for and
  // keeps a scarce pooled browser checked out while it does.
  const deadline = Date.now() + timeoutMs
  const remaining = () => deadline - Date.now()
  // goto + networkidle + content read can add up to ~28s. Skipping the re-navigation
  // when less than that remains is what actually keeps the wait inside timeoutMs;
  // clamping each individual call below then handles the boundary case.
  const RENAV_BUDGET_MS = 28_000
  let clearanceCookieAt: number | undefined
  let lastRenavAt = 0
  let sawPersistentChallenge = false
  let cookieNamesLogged = false
  let renavCount = 0

  const targetHost = (() => {
    try {
      return new URL(originalUrl ?? page.url()).hostname
    } catch {
      return ""
    }
  })()

  const earlyHtml = await bounded(page.content(), 5_000, "")
  if (earlyHtml && !hasDdosGuardChallenge(earlyHtml)) {
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
    return "ok"
  }

  // Let the challenge script boot before polling
  await new Promise((r) => setTimeout(r, 1000))

  while (Date.now() < deadline) {
    try {
      // The interstitial clearing is the authoritative signal, not the cookie: DDoS-Guard
      // sets __ddg1_/__ddgid_ style markers on the challenge page itself, so a cookie
      // alone does not mean solved. Cookies are only used to decide whether it is worth
      // re-navigating below.
      const html = await bounded(page.content(), 5_000, "")
      if (html && !hasDdosGuardChallenge(html)) {
        await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {})
        return "ok"
      }

      const cookies: Array<{ name: string; domain: string }> = await bounded(
        page.context().cookies(),
        5_000,
        [] as Array<{ name: string; domain: string }>,
      )
      const onTargetHost = (c: { domain: string }) =>
        targetHost &&
        (c.domain === targetHost ||
          c.domain === `.${targetHost}` ||
          targetHost.endsWith(c.domain.replace(/^\./, "")))
      // __ddg1_/__ddgid_/__ddgmark_ are set by the interstitial itself, so matching
      // any __ddg* cookie says nothing about having passed. Only the post-challenge
      // cookies count. Matching broadly here meant re-navigating ~5s in, which yanked
      // the page away from the still-running challenge script and then graded the
      // result "ip-blocked" — reproduced from a residential IP, where an actual IP
      // block was not plausible.
      // Safe to read a pre-existing cookie as evidence of THIS solve: tiers 3 and 4
      // both run in a newFreshContext() with no carried-over cookie jar, so anything
      // here was set during this navigation.
      const hasClearanceCookie = cookies.some((c) => /^__ddg[25]_/.test(c.name) && onTargetHost(c))

      if (cookieNamesLogged === false && cookies.length > 0) {
        cookieNamesLogged = true
        console.log(`[ddos-guard] cookies so far: ${cookies.map((c) => c.name).join(", ") || "(none)"}`)
      }

      if (hasClearanceCookie) {
        if (clearanceCookieAt === undefined) {
          clearanceCookieAt = Date.now()
          console.log("[ddos-guard] clearance cookie obtained")
        }

        // Cookie set but still on the interstitial — the auto-reload does not always
        // fire. Navigate ourselves after a grace period, same as the Imperva path.
        // Unlike Imperva we do NOT conclude on the first re-navigation: DDoS-Guard
        // re-challenges cheaply, and one persisting interstitial is not evidence of
        // an IP block. Keep polling until the deadline and let the caller escalate.
        if (
          originalUrl &&
          Date.now() - clearanceCookieAt > 8000 &&
          Date.now() - lastRenavAt > 15_000 &&
          renavCount < MAX_RENAVIGATIONS &&
          remaining() > RENAV_BUDGET_MS
        ) {
          lastRenavAt = Date.now()
          renavCount++
          console.log(
            `[ddos-guard] cookie set but still on challenge page — navigating to original URL (${renavCount}/${MAX_RENAVIGATIONS})`,
          )
          const clamp = (ms: number) => Math.max(500, Math.min(ms, remaining()))
          await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: clamp(15_000) }).catch(() => {})
          await page.waitForLoadState("networkidle", { timeout: clamp(8_000) }).catch(() => {})
          const html2 = await bounded(page.content(), clamp(5_000), "")
          // `html2 &&` matters: a goto timeout or a crashed page yields "", which the
          // detector reports as "no challenge". Without the guard a navigation failure
          // returns "ok" and the tier hands back an empty document as a solved page.
          if (html2 && !hasDdosGuardChallenge(html2)) return "ok"
          if (html2) sawPersistentChallenge = true
        }

        // Full clearance cookie set, and the wall came straight back every time we
        // retried. Nothing further here will change that — the site is rejecting the
        // request on something other than the JS challenge — so give the browser back
        // rather than sitting on it until the deadline.
        if (sawPersistentChallenge && renavCount >= MAX_RENAVIGATIONS) return "ip-blocked"
      }
    } catch {
      // Page is mid-navigation — keep polling
    }

    await new Promise((r) => setTimeout(r, 300))
  }

  // Distinguish "we passed the JS challenge but the wall stayed up" (a reputation
  // signal worth escalating to a residential proxy) from "the challenge never
  // completed at all" (a timeout).
  return sawPersistentChallenge ? "ip-blocked" : "timeout"
}
