import { describe, expect, test } from "bun:test"
import { RequestValidationError } from "@trawl/tiers"
import { requestUrl, validateFlareSolverrRequest, validateScrapeRequest } from "./validation"

const invalidBodies: unknown[] = [undefined, null, [], "text", 42, true]

describe("API request validation", () => {
  for (const body of invalidBodies) {
    test(`rejects non-object body ${JSON.stringify(body)}`, () => {
      expect(() => validateFlareSolverrRequest(body)).toThrow(
        new RequestValidationError("Request body must be a JSON object", 400),
      )
      expect(() => validateScrapeRequest(body)).toThrow(
        new RequestValidationError("Request body must be a JSON object", 400),
      )
    })
  }

  for (const url of [undefined, null, "", "   ", 42]) {
    test(`rejects invalid url ${JSON.stringify(url)}`, () => {
      expect(() => validateFlareSolverrRequest({ url })).toThrow(
        new RequestValidationError("url must be a non-empty string", 400),
      )
      expect(() => validateScrapeRequest({ url })).toThrow(
        new RequestValidationError("url must be a non-empty string", 400),
      )
    })
  }

  test("accepts valid request bodies for both API shapes", () => {
    expect(() => validateFlareSolverrRequest({ cmd: "request.get", url: "https://example.com" })).not.toThrow()
    expect(() => validateScrapeRequest({ method: "GET", url: "https://example.com" })).not.toThrow()
  })

  test("extracts only string URLs for error envelopes", () => {
    expect(requestUrl({ url: "https://example.com" })).toBe("https://example.com")
    expect(requestUrl({ url: 42 })).toBe("")
    expect(requestUrl(null)).toBe("")
  })
})
