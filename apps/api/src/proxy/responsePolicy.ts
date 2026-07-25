import type { ScrapeResult } from "@trawl/types"

export interface ProxyBufferedResponse {
  body: Buffer
  contentType: string
  headers: Record<string, string>
}

const TRANSFORMED_BODY_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-md5",
  "content-range",
  "accept-ranges",
  "etag",
  "transfer-encoding",
])

function isHtml(contentType: string): boolean {
  const base = contentType.split(";", 1)[0]?.trim().toLowerCase()
  return base === "text/html" || base === "application/xhtml+xml"
}

export function responseFromScrapeResult(result: ScrapeResult): ProxyBufferedResponse {
  const contentType = result.contentType ?? result.responseHeaders?.["content-type"] ?? "text/html; charset=utf-8"
  const useRenderedHtml = isHtml(contentType) && result.html.length > 0
  const body = useRenderedHtml
    ? Buffer.from(result.html, "utf8")
    : result.body
      ? Buffer.from(result.body)
      : Buffer.from(result.html, "utf8")

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(result.responseHeaders ?? {})) {
    const lower = name.toLowerCase()
    if (useRenderedHtml && TRANSFORMED_BODY_HEADERS.has(lower)) continue
    headers[lower] = value
  }
  headers["content-type"] = contentType

  return { body, contentType, headers }
}
