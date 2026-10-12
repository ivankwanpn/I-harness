import { createServer } from "node:http"
import { once } from "node:events"
import { expect, it } from "vitest"
import { buildModelClient } from "../src/index.ts"

it.each(["no-headers", "quiet-body", "heartbeat", "stop"])("closes actual local HTTP transport for %s", async mode => {
  let closed!: () => void
  const disconnected = new Promise<void>(resolve => { closed = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const server = createServer((_req, response) => {
    let interval: ReturnType<typeof setInterval> | undefined
    response.on("close", () => { if (interval) clearInterval(interval); closed() })
    if (mode !== "no-headers") { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders() }
    if (mode === "heartbeat") interval = setInterval(() => response.write(": keepalive\n\n"), 5)
    entered()
  })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port")
  const abort = new AbortController()
  const client = buildModelClient({ name: "fixture", displayName: "fixture", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "fixture", modelWait: { firstResponseMs: 150, progressMs: 150 } })
  try {
    const run = (async () => { try { for await (const _ of client.stream({ messages: [], tools: [], systemPrompt: "", signal: abort.signal })) {}; return undefined } catch (e) { return e } })()
    await started
    if (mode === "stop") abort.abort()
    expect(await run).toMatchObject({ code: mode === "stop" ? "ABORTED" : "TIMEOUT", ...(mode === "stop" ? {} : { phase: mode === "no-headers" ? "first-response" : "progress" }) })
    await disconnected
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it.each([400, 401, 402, 403, 404, 408, 429])("preserves retry classification for HTTP %s with a parked error body", async status => {
  let calls = 0
  const server = createServer((_req, response) => {
    calls++
    response.writeHead(status, { "content-type": "application/json" }); response.flushHeaders()
    response.write('{"error":')
  })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port")
  const client = buildModelClient({ name: "fixture", displayName: "fixture", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "fixture", modelWait: { firstResponseMs: 50, progressMs: 50 }, retryPolicy: { mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1 } } })
  try {
    let failure: unknown
    try { for await (const e of client.stream({ messages: [], tools: [], systemPrompt: "" })) if (e.type === "error") failure = e.error } catch (e) { failure = e }
    expect(calls).toBe(status === 408 || status === 429 ? 2 : 1)
    expect(failure).toMatchObject({ code: status === 408 || status === 429 ? "TIMEOUT" : status === 401 || status === 403 ? "AUTH" : status === 402 ? "QUOTA" : "INVALID_ARGUMENT" })
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
