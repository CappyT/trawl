import { describe, expect, test } from "bun:test"
import type { ScrapeResult } from "@trawl/types"
import { responseFromScrapeResult } from "../responsePolicy"

function result(overrides: Partial<ScrapeResult>): ScrapeResult {
  return {
    url: "https://example.test/",
    html: "",
    cookies: [],
    userAgent: "test",
    statusCode: 200,
    tier: 3,
    sessionCached: false,
    timings: [],
    totalMs: 1,
    ...overrides,
  }
}

describe("responseFromScrapeResult", () => {
  test("returns rendered HTML after a browser tier instead of the raw challenge response", () => {
    const response = responseFromScrapeResult(
      result({
        html: "<html><title>Real page</title></html>",
        body: Buffer.from("<html><title>Just a moment...</title></html>"),
        contentType: "text/html; charset=utf-8",
        responseHeaders: {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "br",
          "content-length": "999",
        },
      }),
    )

    expect(response.body.toString()).toContain("Real page")
    expect(response.body.toString()).not.toContain("Just a moment")
    expect(response.headers["content-encoding"]).toBeUndefined()
    expect(response.headers["content-length"]).toBeUndefined()
  })

  test("preserves raw bytes for binary responses", () => {
    const bytes = Uint8Array.from([0, 255, 1, 2, 3])
    const response = responseFromScrapeResult(
      result({
        html: "",
        body: bytes,
        contentType: "application/octet-stream",
        responseHeaders: {
          "content-type": "application/octet-stream",
          "content-range": "bytes 0-4/100",
        },
      }),
    )

    expect([...response.body]).toEqual([...bytes])
    expect(response.headers["content-range"]).toBe("bytes 0-4/100")
  })
})
