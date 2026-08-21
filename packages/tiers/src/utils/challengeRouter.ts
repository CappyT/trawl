import type { Page } from "patchright"
import { waitForAkamaiResolution } from "./akamaiWait"
import { waitForChallengeResolution } from "./challengeWait"
import { waitForDdosGuardResolution } from "./ddosGuardWait"
import { type ChallengeType, detectChallengeType } from "./detect"
import { waitForImpervaResolution } from "./impervaWait"

type Resolution = "ok" | "ip-blocked" | "timeout"
type Waiter = (page: Page, timeoutMs: number, originalUrl?: string) => Promise<Resolution>

interface ChallengeWaiters {
  cloudflare: (
    page: Page,
    timeoutMs: number,
    originalUrl?: string,
    responseHeaders?: () => Record<string, string>,
  ) => Promise<Resolution>
  imperva: Waiter
  akamai: Waiter
  ddosGuard: Waiter
}

const defaultWaiters: ChallengeWaiters = {
  cloudflare: waitForChallengeResolution,
  imperva: waitForImpervaResolution,
  akamai: waitForAkamaiResolution,
  ddosGuard: waitForDdosGuardResolution,
}

export async function routeChallengeWait(
  page: Page,
  html: string,
  headers: Record<string, string>,
  timeoutMs: number,
  originalUrl?: string,
  waiters: ChallengeWaiters = defaultWaiters,
): Promise<{ challengeType: ChallengeType; resolution: Resolution }> {
  const challengeType = detectChallengeType(html, headers)
  const resolution =
    challengeType === "imperva"
      ? await waiters.imperva(page, timeoutMs, originalUrl)
      : challengeType === "akamai"
        ? await waiters.akamai(page, timeoutMs, originalUrl)
        : challengeType === "ddos-guard"
          ? await waiters.ddosGuard(page, timeoutMs, originalUrl)
          : await waiters.cloudflare(page, timeoutMs, originalUrl, () => headers)
  return { challengeType, resolution }
}
