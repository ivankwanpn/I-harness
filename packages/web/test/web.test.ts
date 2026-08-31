import { afterEach, beforeEach, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createWebTools } from "../src/index.ts"
import { createServer } from "node:http"

async function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/html") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(`<html><head><title>My Page</title><style>body{color:red}</style><script>let x=1;</script></head><body><p>Hello &amp; <b>world</b></p></body></html>`)
    } else if (url.pathname === "/text") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("plain text body")
    } else if (url.pathname === "/big") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(`<html><body>${"a".repeat(200_000)}</body></html>`)
    } else if (url.pathname === "/redirect") { res.writeHead(302, { location: "/html" }); res.end() }
    else { res.writeHead(404); res.end("no") }
  })
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as import("node:net").AddressInfo).port)))
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

let srv: { port: number; close: () => Promise<void> }
beforeEach(async () => { srv = await startServer() })
afterEach(async () => { await srv.close() })

it("webfetch extracts text: title + stripped markup + entities decoded", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "webfetch")!
  const out = (await t.execute({ url: `http://127.0.0.1:${srv.port}/html` }, {})) as { url: string; title: string; text: string }
  expect(out.title).toBe("My Page")
  expect(out.text).toContain("Hello & world")
  expect(out.text).not.toContain("<b>")
  expect(out.text).not.toContain("style")
})

it("webfetch: plain text passthrough; truncates oversized bodies with a marker", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "webfetch")!
  const plain = (await t.execute({ url: `http://127.0.0.1:${srv.port}/text` }, {})) as { text: string }
  expect(plain.text.trim()).toBe("plain text body")
  const big = (await t.execute({ url: `http://127.0.0.1:${srv.port}/big`, maxChars: 1000 }, {})) as { text: string; truncated: boolean }
  expect(big.truncated).toBe(true)
  expect(big.text.length).toBeLessThan(2000)
})

it("webfetch follows redirects and fails closed on non-http(s) protocol and HTTP errors", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "webfetch")!
  const redir = (await t.execute({ url: `http://127.0.0.1:${srv.port}/redirect` }, {})) as { title: string }
  expect(redir.title).toBe("My Page")
  await expect(t.execute({ url: "file:///etc/passwd" }, {})).rejects.toThrow(/WEB_UNSUPPORTED_PROTOCOL/)
  await expect(t.execute({ url: `http://127.0.0.1:${srv.port}/404` }, {})).rejects.toThrow(/WEB_FETCH_FAILED.*404/)
})

it("websearch fails closed without a provider", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "websearch")!
  await expect(t.execute({ query: "x" }, {})).rejects.toThrow(/NO_PROVIDER/)
})
