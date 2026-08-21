import { describe, expect, test } from "bun:test"
import { detectChallengeType, hasDdosGuardChallenge, isBlocked, isCloudflarePage, needsJs } from "../src/utils/detect"

// Trimmed from a real DDoS-Guard interstitial (annas-archive.gl/search, HTTP 403, 902 bytes).
const DDG_INTERSTITIAL = `<html><head><title>DDoS-Guard</title>
<link rel="stylesheet" href="/.well-known/ddos-guard/js-challenge/index.css">
<script defer src="/.well-known/ddos-guard/js-challenge/view.js"></script>
<script defer src="/.well-known/ddos-guard/js-challenge/index.js"></script>
<script src="https://check.ddos-guard.net/check.js"></script></head>
<body><div id="ddg-img-loading"></div>
<h1 id="ddg-l10n-title">Checking your browser before accessing <span class="ddg-origin"></span></h1>
<p id="ddg-l10n-description">Please wait a few seconds. Once this check is complete, the website will open automatically</p>
<div id="request-info"></div></body></html>`

describe("DDoS-Guard detection", () => {
  test("the interstitial is graded as ddos-guard, not cloudflare", () => {
    expect(hasDdosGuardChallenge(DDG_INTERSTITIAL)).toBe(true)
    expect(detectChallengeType(DDG_INTERSTITIAL)).toBe("ddos-guard")
    // Regression: it used to match isCloudflarePage(), which routed it into the CF
    // interstitial wait. That polls for cf_clearance and CF DOM markers a DDoS-Guard
    // page never emits, so it consumed the whole timeout and reported
    // "cloudflare-persistent". tiers 3/4 call isCloudflarePage() directly for their
    // persistence check, so this must be false there too, not merely ordered later
    // inside detectChallengeType().
    expect(isCloudflarePage(DDG_INTERSTITIAL, {})).toBe(false)
  })

  test("the interstitial still counts as blocked and as needing JS", () => {
    expect(isBlocked(403, DDG_INTERSTITIAL)).toBe(true)
    expect(needsJs(DDG_INTERSTITIAL, {})).toBe(true)
  })

  test("a real page from a DDoS-Guard-fronted site is not a challenge", () => {
    // DDoS-Guard sets `Server: ddos-guard` on every response it fronts — verified on
    // annas-archive.gl, where the 200 and the 403 interstitial carry the identical
    // header. Detection must not key off it, or every successful page from such a
    // site is graded a wall and sent back through the solver forever.
    const realPage = `<html><head><title>Search results</title></head><body>${"<a href='/md5/abc'>book</a>".repeat(200)}</body></html>`
    expect(hasDdosGuardChallenge(realPage, { server: "ddos-guard" })).toBe(false)
    expect(detectChallengeType(realPage, { server: "ddos-guard" })).toBe("none")
    expect(isBlocked(200, realPage)).toBe(false)
  })

  test("merely mentioning ddos-guard.net is not a challenge, at any size", () => {
    // Detection requires challenge-specific evidence (asset paths, DOM ids, check.js).
    // A bare provider mention is not evidence, and a size gate would not make it so.
    const small = `<html><body><p>Protected by ddos-guard.net</p></body></html>`
    const big = `<html><body><p>Protected by ddos-guard.net</p>${"x".repeat(5000)}</body></html>`
    expect(hasDdosGuardChallenge(small)).toBe(false)
    expect(hasDdosGuardChallenge(big)).toBe(false)
  })

  test("an authoritative cf-mitigated header wins over DDoS-Guard markers, consistently", () => {
    // A page fronted by both must be graded Cloudflare — the CF header is definitive,
    // the DDoS-Guard markers are heuristics. Both entry points must agree: an earlier
    // cut had isCloudflarePage() say cloudflare while detectChallengeType() said
    // ddos-guard, which sent tiers 3/4 to the DDoS-Guard waiter and then judged the
    // outcome with the Cloudflare persistence check.
    const cfHeaders = { "cf-mitigated": "challenge" }
    expect(isCloudflarePage(DDG_INTERSTITIAL, cfHeaders)).toBe(true)
    expect(detectChallengeType(DDG_INTERSTITIAL, cfHeaders)).toBe("cloudflare-interstitial")
  })
})
