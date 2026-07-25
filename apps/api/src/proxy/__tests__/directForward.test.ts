import { afterAll, describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { directForwardHttp } from "../directForward"

const fullBody = Buffer.from("0123456789ABCDEF")

const chunked = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

const fetchFixture = (req: Request): Response => {
  const { pathname } = new URL(req.url)
  if (pathname === "/chunked-html")
    return new Response(
      chunked(Buffer.from("<!doctype html><title>Normal page</title>"), Buffer.from("<p>small response</p>")),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    )
  if (pathname === "/chunked-challenge")
    return new Response(
      chunked(Buffer.from('<!doctype html><title>Just a moment...</title><div id="cf-browser-verification"></div>')),
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    )
  if (pathname === "/gzip-challenge") {
    const body = gzipSync('<!doctype html><title>Just a moment...</title><div id="cf-browser-verification"></div>')
    return new Response(body, {
      status: 503,
      headers: { "Content-Encoding": "gzip", "Content-Type": "text/html; charset=utf-8" },
    })
  }
  if (pathname === "/video")
    return new Response(chunked(Buffer.from([0, 1, 2, 3]), Buffer.from([4, 5, 6, 7])), {
      headers: { "Content-Type": "video/mp4" },
    })
  if (pathname === "/fixed-video")
    return new Response(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), {
      headers: { "Content-Type": "video/mp4" },
    })

  const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "")
  if (!match)
    return new Response(fullBody, {
      headers: { "Content-Type": "application/octet-stream" },
    })

  const start = Number(match[1])
  const end = Number(match[2])
  const body = fullBody.subarray(start, end + 1)
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${fullBody.length}`,
      "Content-Type": "application/octet-stream",
    },
  })
}

const createTestServer = () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 30_000 + ((process.pid + attempt * 997) % 20_000)
    try {
      return Bun.serve({ fetch: fetchFixture, hostname: "127.0.0.1", port })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("port")) throw error
    }
  }
  throw new Error("failed to bind direct-forward test server")
}

const server = createTestServer()
const baseUrl = `http://127.0.0.1:${server.port}`

afterAll(() => server.stop(true))

describe("directForwardHttp — Range / 206 Partial Content", () => {
  test("forwards Range request header and gets 206 Partial Content back", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/file.bin`,
      method: "GET",
      headers: { Range: "bytes=4-9" },
    })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.status).toBe(206)
    expect(result.body.toString("latin1")).toBe("456789")
    expect(result.contentLength).toBe(6)
    expect(result.headers["content-range"]).toBe("bytes 4-9/16")
  })

  test("forwards multiple range types (single-byte suffix)", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/file.bin`,
      method: "GET",
      headers: { Range: "bytes=15-15" },
    })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.status).toBe(206)
    expect(result.body.toString("latin1")).toBe("F")
    expect(result.contentLength).toBe(1)
    expect(result.headers["content-range"]).toBe("bytes 15-15/16")
  })

  test("no Range header → 200 + full body (Range pass-through, not injection)", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/file.bin`,
      method: "GET",
      headers: {},
    })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.status).toBe(200)
    expect(result.body.length).toBe(fullBody.length)
    expect(result.body.toString("latin1")).toBe(fullBody.toString("latin1"))
    expect(result.headers["content-range"]).toBeUndefined()
  })

  test("preserves Content-Range through the proxy without re-computing", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/file.bin`,
      method: "GET",
      headers: { Range: "bytes=0-3" },
    })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.headers["content-range"]).toBe("bytes 0-3/16")
    expect(result.headers["content-length"]).toBe("4")
    expect(result.body.length).toBe(4)
  })
})

describe("directForwardHttp — buffered by default", () => {
  test("buffers and de-chunks small HTML instead of treating it as a stream", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/chunked-html`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.body.toString()).toBe("<!doctype html><title>Normal page</title><p>small response</p>")
    expect(result.challengeDetected).toBe(false)
  })

  test("detects a challenge in a chunked HTML response", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/chunked-challenge`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.challengeDetected).toBe(true)
    expect(result.body.toString()).toContain("Just a moment")
  })

  test("detects a challenge in a compressed HTML response", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/gzip-challenge`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.challengeDetected).toBe(true)
    expect(result.headers["content-encoding"]).toBe("gzip")
  })

  test("streams explicit video responses", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/video`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("stream")
    if (result.mode !== "stream") return
    result.socket.destroy()
  })

  test("streams video even when Content-Length is known", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/fixed-video`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("stream")
    if (result.mode !== "stream") return
    expect(result.contentLength).toBe(8)
    result.socket.destroy()
  })
})
