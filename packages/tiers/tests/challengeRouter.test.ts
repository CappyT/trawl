import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { routeChallengeWait } from "../src/utils/challengeRouter"
import { DDOS_GUARD_INTERSTITIAL } from "./fixtures/ddosGuard"

describe("browser challenge routing", () => {
  test("passes response headers into detection and routes an authoritative CF challenge to its waiter", async () => {
    const calls: string[] = []
    const waiter = (name: string) => async () => {
      calls.push(name)
      return "ok" as const
    }
    const result = await routeChallengeWait(
      {} as Page,
      DDOS_GUARD_INTERSTITIAL,
      { "cf-mitigated": "challenge" },
      100,
      "https://example.test/",
      {
        cloudflare: waiter("cloudflare"),
        ddosGuard: waiter("ddos-guard"),
        imperva: waiter("imperva"),
        akamai: waiter("akamai"),
      },
    )

    expect(result.challengeType).toBe("cloudflare-interstitial")
    expect(calls).toEqual(["cloudflare"])
  })

  test("routes DDoS-Guard markers to the dedicated waiter without the CF header", async () => {
    const calls: string[] = []
    const waiter = (name: string) => async () => {
      calls.push(name)
      return "ok" as const
    }
    const result = await routeChallengeWait({} as Page, DDOS_GUARD_INTERSTITIAL, {}, 100, undefined, {
      cloudflare: waiter("cloudflare"),
      ddosGuard: waiter("ddos-guard"),
      imperva: waiter("imperva"),
      akamai: waiter("akamai"),
    })

    expect(result.challengeType).toBe("ddos-guard")
    expect(calls).toEqual(["ddos-guard"])
  })
})
