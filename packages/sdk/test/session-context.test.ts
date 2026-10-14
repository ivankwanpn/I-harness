import { expect, it } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { createSdkServer } from "../src/server.ts"
import { decodeFrame, encodeFrame, makeRequest } from "../src/protocol.ts"

it("reports estimated active context against the resolved model window", async () => {
  const service = createSessionService({ workspace: process.cwd(), modelBindingFor: async () => ({ status: "ready", binding: {
    providerId: "local", modelId: "mock", label: "Local mock", contextWindow: 100000,
    model: { async *stream() { yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const } },
  } }) })
  const server = createSdkServer(service)
  try {
    const hello = decodeFrame((await server.handleLine(encodeFrame(makeRequest(1, "initialize", {}))))!)
    expect(hello).toMatchObject({ result: { capabilities: { "session-context": ["1"] } } })
    await server.handleLine(encodeFrame(makeRequest(2, "session/prompt", { sessionId: "context", prompt: "hello" })))
    const state = decodeFrame((await server.handleLine(encodeFrame(makeRequest(3, "session/context", { sessionId: "context" }))))!)
    expect(state).toMatchObject({ result: { kind: "unavailable", reason: "Accepted output awaits the next protocol projection", snapshot: { contextWindow: 100000, admission: "unavailable", coverage: "neutral-only" } } })
    const result = (state as { result: { snapshot: { estimatedInputTokens: number; roleTokens: { user: number } } } }).result
    expect(result.snapshot.estimatedInputTokens).toBeGreaterThan(0)
    expect(result.snapshot.roleTokens.user).toBeGreaterThan(0)
  } finally { await server.close(); await service.close() }
})
