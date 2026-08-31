import { describe, expect, it } from "vitest"
import { once } from "node:events"
import { createServer } from "node:http"
import type { Duplex } from "node:stream"
import WebSocket from "ws"
import { WebSocketMuxServer, type MuxMessageHandlers, type StreamOpener } from "../src/mux.ts"
import type { ApprovalResponseWire } from "../src/types.ts"

async function withServer(
  opener: StreamOpener,
  run: (base: string) => Promise<void>,
  handlers: MuxMessageHandlers = {},
) {
  const mux = new WebSocketMuxServer(opener, handlers)
  const http = createServer((_req, res) => { res.writeHead(404); res.end() })
  http.on("upgrade", (_req, socket, head) => mux.handleUpgrade(_req, socket as Duplex, head))
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve))
  const addr = http.address() as { port: number }
  try {
    await run(`ws://127.0.0.1:${addr.port}`)
  } finally {
    mux.close()
    http.close()
  }
}

describe("WebSocketMuxServer", () => {
  it("opens one stream, receives ready + items + end", async () => {
    await withServer(async (endpoint, _p, signal) => {
      expect(endpoint).toBe("session")
      return (async function* () {
        yield { type: "turn/start" }
        yield { type: "assistant/message", text: "hi" }
        void signal
      })()
    }, async (base) => {
      const ws = new WebSocket(base + "/api/mux")
      await once(ws, "open")
      ws.send(JSON.stringify({ type: "open", streamId: "s1", endpoint: "session", payload: {} }))
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))
      await new Promise(res => setTimeout(res, 100))
      expect(messages.some(m => m.type === "ready" && m.streamId === "s1")).toBe(true)
      expect(messages.some(m => m.type === "item" && m.streamId === "s1" && m.value.type === "turn/start")).toBe(true)
      expect(messages.some(m => m.type === "end" && m.streamId === "s1")).toBe(true)
      ws.close()
    })
  })

  it("cancels a stream (endpoint aborts)", async () => {
    let aborted = false
    await withServer(async (_endpoint, _p, signal) => {
      return (async function* () {
        while (true) {
          if (signal.aborted) { aborted = true; return }
          yield { type: "ping" }
          await new Promise(r => setTimeout(r, 10))
        }
      })()
    }, async (base) => {
      const ws = new WebSocket(base + "/api/mux")
      await once(ws, "open")
      ws.send(JSON.stringify({ type: "open", streamId: "s1", endpoint: "session", payload: {} }))
      await new Promise(res => setTimeout(res, 50))
      ws.send(JSON.stringify({ type: "cancel", streamId: "s1" }))
      await new Promise(res => setTimeout(res, 50))
      expect(aborted).toBe(true)
      ws.close()
    })
  })

  // Controller ruling 1: `{type:"approval"}` is a third client message — not
  // an open/cancel. It must route to handlers.onApproval and must NOT create
  // (or collide with) a stream, even when its streamId matches an open one.
  it("routes {type:'approval'} messages to handlers.onApproval without creating a stream", async () => {
    const received: ApprovalResponseWire[] = []
    let sawOpened = false
    await withServer(async (endpoint) => {
      expect(endpoint).toBe("approval")
      sawOpened = true
      return (async function* () { /* stays open until cancelled */ })()
    }, async (base) => {
      const ws = new WebSocket(base + "/api/mux")
      await once(ws, "open")
      const messages: any[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))
      ws.send(JSON.stringify({ type: "open", streamId: "a1", endpoint: "approval", payload: {} }))
      await new Promise(res => setTimeout(res, 50))
      expect(sawOpened).toBe(true)
      // Decision referencing the OPEN stream — must not throw "duplicate stream".
      ws.send(JSON.stringify({ type: "approval", streamId: "a1", value: { approvalId: "ap-1", approved: true } }))
      await new Promise(res => setTimeout(res, 50))
      expect(received).toEqual([{ approvalId: "ap-1", approved: true }])
      // No stream was created by the approval message: opening "ap-x" fresh succeeds.
      ws.send(JSON.stringify({ type: "open", streamId: "ap-x", endpoint: "approval", payload: {} }))
      await new Promise(res => setTimeout(res, 50))
      expect(messages.some(m => m.type === "ready" && m.streamId === "ap-x")).toBe(true)
      ws.close()
    }, { onApproval: (value) => { received.push(value) } })
  })
})
