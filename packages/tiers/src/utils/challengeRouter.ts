import type { Page } from "patchright"
import { waitForAkamaiResolution } from "./akamaiWait"
import { type AwsWafResolution, waitForAwsWafResolution } from "./awsWafWait"
import { waitForChallengeResolution } from "./challengeWait"
import { waitForDdosGuardResolution } from "./ddosGuardWait"
import { type ChallengeType, detectChallengeType, getAwsWafAction, hasAwsWafCaptcha } from "./detect"
import { waitForImpervaResolution } from "./impervaWait"

type Resolution = AwsWafResolution
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
  awsWaf: (
    page: Page,
    timeoutMs: number,
    originalUrl?: string,
    initialTokens?: ReadonlySet<string>,
  ) => Promise<Resolution>
}

const defaultWaiters: ChallengeWaiters = {
  cloudflare: waitForChallengeResolution,
  imperva: waitForImpervaResolution,
  akamai: waitForAkamaiResolution,
  ddosGuard: waitForDdosGuardResolution,
  awsWaf: (page, timeoutMs, originalUrl, initialTokens) =>
    waitForAwsWafResolution(page, timeoutMs, originalUrl, { initialTokens }),
}

export async function routeChallengeWait(
  page: Page,
  html: string,
  headers: Record<string, string>,
  timeoutMs: number,
  originalUrl?: string,
  waiters: ChallengeWaiters = defaultWaiters,
  status?: number,
  initialAwsWafTokens?: ReadonlySet<string>,
): Promise<{ challengeType: ChallengeType; resolution: Resolution }> {
  const challengeType = detectChallengeType(html, headers, status)
  if (getAwsWafAction(status, headers) === "captcha" || hasAwsWafCaptcha(html)) {
    return { challengeType: "aws-waf", resolution: "captcha-required" }
  }
  const resolution =
    challengeType === "imperva"
      ? await waiters.imperva(page, timeoutMs, originalUrl)
      : challengeType === "akamai"
        ? await waiters.akamai(page, timeoutMs, originalUrl)
        : challengeType === "ddos-guard"
          ? await waiters.ddosGuard(page, timeoutMs, originalUrl)
          : challengeType === "aws-waf"
            ? await waiters.awsWaf(page, timeoutMs, originalUrl, initialAwsWafTokens)
            : await waiters.cloudflare(page, timeoutMs, originalUrl, () => headers)
  return { challengeType, resolution }
}
