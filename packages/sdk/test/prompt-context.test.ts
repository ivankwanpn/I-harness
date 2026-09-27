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
    const reply = await server.handleLine(encodeFrame(makeRequest(2, "session/prompt", { sessionId: "context", prompt: "/hello", context: 'Workspace references: ["a.md"]', clientToken: "desktop-request-1" })))
    expect(isRpcSuccess(decodeFrame(reply!))).toBe(true)
    expect(service.liveSession("context")?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent/input/admitted", text: 'Expanded command\n\nWorkspace references: ["a.md"]', clientToken: "desktop-request-1" }),
      expect.objectContaining({ type: "user/message", text: 'Expanded command\n\nWorkspace references: ["a.md"]' }),
    ]))
  } finally { await server.close(); await service.close() }
})

it("admits a bounded image and promotes it into the model-visible user message", async () => {
  const image = { mediaType: "image/png", dataBase64: "aGVsbG8=", name: "sample.png" }
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", mockScript: [{ role: "assistant", text: "seen" }] })
  const notifications: unknown[] = []
  const server = createSdkServer(service, { onNotify: (message) => notifications.push(message) })
  try {
    const hello = decodeFrame((await server.handleLine(encodeFrame(makeRequest(1, "initialize", {}))))!)
    expect(hello).toMatchObject({ result: { capabilities: { "prompt-images": ["1"] } } })
    const reply = await server.handleLine(encodeFrame(makeRequest(2, "session/prompt", { sessionId: "images", prompt: "inspect", images: [image] })))
    expect(isRpcSuccess(decodeFrame(reply!))).toBe(true)
    const raw = service.liveSession("images")!.events
    const admitted = raw.find((event) => event.type === "agent/input/admitted")!
    const user = raw.find((event) => event.type === "user/message")!
    expect(admitted).toMatchObject({ images: [image] })
    expect(user).toMatchObject({ imageInputId: admitted.type === "agent/input/admitted" ? admitted.inputId : "" })
    expect(user).not.toHaveProperty("images")
    const history = decodeFrame((await server.handleLine(encodeFrame(makeRequest(3, "session/history", { sessionId: "images", afterSeq: admitted.seq! + 1, limit: 100 }))))!)
    expect(history).toMatchObject({ result: { events: expect.arrayContaining([expect.objectContaining({ type: "user/message", images: [image] })]) } })
    expect((history as { result: { events: { type: string }[] } }).result.events.some((event) => event.type === "agent/input/admitted")).toBe(false)
    const completeHistory = decodeFrame((await server.handleLine(encodeFrame(makeRequest(4, "session/history", { sessionId: "images", afterSeq: 0, limit: 100 }))))!)
    const completeEvents = (completeHistory as { result: { events: Record<string, unknown>[] } }).result.events
    expect(completeEvents.find((event) => event.type === "agent/input/admitted")).not.toHaveProperty("images")
    expect(completeEvents.find((event) => event.type === "user/message")).toMatchObject({ images: [image] })
    expect(admitted).toHaveProperty("images", [image])
    const events = notifications.filter((item): item is { method: string; params: { event: Record<string, unknown> } } => !!item && typeof item === "object" && (item as { method?: string }).method === "session/event")
      .map((item) => item.params.event)
    expect(events.find((event) => event.type === "agent/input/admitted")).not.toHaveProperty("images")
    expect(events.find((event) => event.type === "user/message")).toMatchObject({ images: [image] })
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
