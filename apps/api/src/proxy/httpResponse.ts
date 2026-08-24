// Lightweight HTTP/1.1 response serialization helpers.
// Kept separate from server.ts so unit tests can import without loading
// the proxy server's heavy dependency chain (browser pool, scrape tiers).

import net from "node:net"

// RFC 7230 §6.1 hop-by-hop headers — must stay in sync with packages/tiers/src/utils/sanitize.ts.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function reason(status: number): string {
  const map: Record<number, string> = {
    200: "OK",
    403: "Forbidden",
    404: "Not Found",
    500: "Internal Server Error",
    502: "Bad Gateway",
  }
  return map[status] ?? "OK"
}

export function writeResponse(
  sock: net.Socket,
  status: number,
  body: Buffer,
  contentType = "text/html; charset=utf-8",
): void {
  const head =
    `HTTP/1.1 ${status} ${reason(status)}\r\n` +
    `Content-Type: ${contentType}\r\n` +
    `Content-Length: ${body.length}\r\n` +
    "Connection: close\r\n\r\n"
  sock.write(head)
  sock.write(body)
  sock.end()
}

// Buffered responses preserve end-to-end headers and derive a fresh body length.
export function writeResponseFromBuffer(
  sock: net.Socket,
  status: number,
  upstreamHeaders: Record<string, string>,
  body: Buffer,
  fallbackContentType: string,
): void {
  const ct = upstreamHeaders["content-type"] ?? fallbackContentType
  const headerLines: string[] = [`HTTP/1.1 ${status} ${reason(status)}`]
  let emittedContentType = false
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === "content-length") continue
    if (lower === "content-type") emittedContentType = true
    // Playwright joins multiple Set-Cookie values with \n into one map entry.
    // Emit each cookie as its own header line — RFC 6265 forbids comma-folding.
    if (lower === "set-cookie") {
      for (const cookie of value.split(/\r?\n/)) {
        const trimmed = cookie.trim()
        if (trimmed) headerLines.push(`${name}: ${trimmed}`)
      }
      continue
    }
    headerLines.push(`${name}: ${value}`)
  }
  if (!emittedContentType) headerLines.push(`Content-Type: ${ct}`)
  headerLines.push(`Content-Length: ${body.length}`)
  headerLines.push("Connection: close")
  sock.write(`${headerLines.join("\r\n")}\r\n\r\n`)
  sock.write(body)
  sock.end()
}

// Streamed responses retain upstream transfer framing.
export function writeResponseFromStream(
  sock: net.Socket,
  status: number,
  upstreamHeaders: Record<string, string>,
  upstreamSocket: net.Socket,
  fallbackContentType: string,
  requestBodyLength: number,
  prefix?: Buffer,
): void {
  const headerLines: string[] = [`HTTP/1.1 ${status} ${reason(status)}`]
  let emittedContentType = false
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase()
    // The streamed bytes retain upstream HTTP/1.1 chunk framing, so preserve
    // Transfer-Encoding. Other hop-by-hop headers remain connection-local.
    if (HOP_BY_HOP.has(lower) && lower !== "transfer-encoding") continue
    if (lower === "content-type") emittedContentType = true
    headerLines.push(`${name}: ${value}`)
  }
  if (!emittedContentType) headerLines.push(`Content-Type: ${fallbackContentType}`)
  if (requestBodyLength > 0) headerLines.push(`X-Forwarded-Body-Length: ${requestBodyLength}`)
  headerLines.push("Connection: close")
  // Write HTTP headers first, then prefix body bytes (which arrived in the same
  // TCP segment as upstream's response headers), then pipe the rest of the body.
  sock.write(`${headerLines.join("\r\n")}\r\n\r\n`)
  if (prefix?.length) sock.write(prefix)
  upstreamSocket.pipe(sock)
  sock.on("error", () => upstreamSocket.destroy())
  upstreamSocket.on("error", () => sock.destroy())
  upstreamSocket.on("end", () => sock.end())
  upstreamSocket.on("close", () => sock.end())
}
