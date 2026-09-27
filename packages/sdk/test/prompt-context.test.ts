import { expect, it } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { createSdkServer } from "../src/server.ts"
import { decodeFrame, encodeFrame, isRpcSuccess, makeRequest } from "../src/protocol.ts"
import { PassThrough, Writable } from "node:stream"
import { HarnessClient } from "../src/client.ts"

it("refuses context on a peer that would silently ignore the added field", async () => {
  const input = new PassThrough()
  const methods: string[] = []
  const output = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk))
    methods.push(request.method)
    if (request.id !== undefined) queueMicrotask(() => input.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize" ? { name: "old", version: "1", protocolVersion: 3, capabilities: {} } : { ok: true } }) + "\n"))
    done()
  } })
  const client = new HarnessClient(input, output)
  try {
    await client.initialize()
    await expect(client.run({ prompt: "hello", context: "must not disappear" })).rejects.toThrow("context")
    expect(methods).not.toContain("session/prompt")
  } finally { await client.close() }
})
it("retains context after prompt command expansion and in durable input events", async () => {
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", mockScript: [{ role: "assistant", text: "done" }], transformPrompt: async () => "Expanded command" })
  const server = createSdkServer(service)
  try {
    await server.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
    const reply = await server.handleLine(encodeFrame(makeRequest(2, "session/prompt", { sessionId: "context", prompt: "/hello", context: 'Workspace references: ["a.md"]' })))
    expect(isRpcSuccess(decodeFrame(reply!))).toBe(true)
    expect(service.liveSession("context")?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent/input/admitted", text: 'Expanded command\n\nWorkspace references: ["a.md"]' }),
      expect.objectContaining({ type: "user/message", text: 'Expanded command\n\nWorkspace references: ["a.md"]' }),
    ]))
  } finally { await server.close(); await service.close() }
})

it("admits a bounded image and promotes it into the model-visible user message", async () => {
  const image = { mediaType: "image/png", dataBase64: "aGVsbG8=", name: "sample.png" }
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", mockScript: [{ role: "assistant", text: "seen" }] })
  const server = createSdkServer(service)
  try {
    const hello = decodeFrame((await server.handleLine(encodeFrame(makeRequest(1, "initialize", {}))))!)
    expect(hello).toMatchObject({ result: { capabilities: { "prompt-images": ["1"] } } })
    const reply = await server.handleLine(encodeFrame(makeRequest(2, "session/prompt", { sessionId: "images", prompt: "inspect", images: [image] })))
    expect(isRpcSuccess(decodeFrame(reply!))).toBe(true)
    expect(service.liveSession("images")?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent/input/admitted", images: [image] }),
      expect.objectContaining({ type: "user/message", images: [image] }),
    ]))
  } finally { await server.close(); await service.close() }
})

it("refuses eleven images before creating a session", async () => {
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", mockScript: [{ role: "assistant", text: "seen" }] })
  const server = createSdkServer(service)
  try {
    await server.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
    const image = { mediaType: "image/png", dataBase64: "aGVsbG8=" }
    const reply = decodeFrame((await server.handleLine(encodeFrame(makeRequest(2, "session/prompt", { sessionId: "too-many", prompt: "inspect", images: Array(11).fill(image) }))))!)
    expect(reply).toMatchObject({ error: { code: -32602 } })
    expect(service.liveSession("too-many")).toBeUndefined()
  } finally { await server.close(); await service.close() }
})
