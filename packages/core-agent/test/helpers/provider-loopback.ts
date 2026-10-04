import { createServer, type ServerResponse } from "node:http"

export type ProviderEvent = Record<string, unknown>
export interface LoopbackRequest { path: string | undefined; body: Record<string, unknown> }
export type LoopbackRound = (response: ServerResponse, request: LoopbackRequest) => Promise<void>

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** Deliberately split SSE framing, JSON tokens, and multibyte text across HTTP writes. */
export async function writeSplitSse(response: ServerResponse, events: readonly ProviderEvent[]): Promise<void> {
  const bytes = Buffer.from(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""))
  for (let offset = 0; offset < bytes.length; offset += 17) {
    response.write(bytes.subarray(offset, offset + 17))
    await new Promise<void>((done) => setImmediate(done))
  }
}

/** Real transport, bound to loopback only; scripted rounds never contact a provider. */
export async function createLoopbackProvider(path: string, rounds: readonly LoopbackRound[]) {
  const requests: LoopbackRequest[] = []
  const errors: unknown[] = []
  const server = createServer(async (incoming, response) => {
    try {
      if (incoming.method !== "POST" || incoming.url !== path) {
        response.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const request: LoopbackRequest = { path: incoming.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }
      const round = rounds[requests.length]
      requests.push(request)
      if (!round) throw new Error("unexpected loopback provider round")
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      await round(response, request)
      response.end()
    } catch (error) {
      errors.push(error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  await new Promise<void>((done, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); done() })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing loopback address")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    errors,
    async close() {
      const closed = new Promise<void>((done) => server.close(() => done()))
      server.closeAllConnections()
      await closed
    },
  }
}
