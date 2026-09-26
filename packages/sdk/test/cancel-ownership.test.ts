import { it, expect, vi } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { createSdkServer } from "../src/server.ts"

it("cancels running A when B is queued and lets B retain its own lifetime", async () => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  let firstSignal: AbortSignal | undefined
  let calls = 0
  const service = createSessionService({
    workspace: process.cwd(), modelPolicy: "required",
    modelBindingFor: async () => ({ status: "ready", binding: {
      providerId: "test", modelId: "test", label: "test", model: {
        async *stream(request) {
          calls++
          if (calls === 1) {
            firstSignal = request.signal
            await Promise.race([gate, new Promise<void>(r => request.signal?.addEventListener("abort", () => r(), { once: true }))])
            request.signal?.throwIfAborted()
          }
          yield { type: "text/chunk", text: "finished" }
          yield { type: "end" }
        },
      },
    } }),
  })
  const server = createSdkServer(service)
  const call = (id: number, method: string, params: unknown) => server.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  let a: Promise<string | null> | undefined
  let b: Promise<string | null> | undefined
  try {
    await call(1, "initialize", {})
    a = call(2, "session/prompt", { sessionId: "s", prompt: "A" })
    await vi.waitFor(() => expect(firstSignal).toBeDefined())
    b = call(3, "session/prompt", { sessionId: "s", prompt: "B" })
    await vi.waitFor(() => expect(service.queue("s")).toHaveLength(2))
    expect(JSON.parse((await call(4, "session/cancel", { sessionId: "s" }))!).result).toEqual({ cancelled: true })
    expect(firstSignal!.aborted).toBe(true)
    expect(JSON.parse((await a)!)).toHaveProperty("error")
    expect(JSON.parse((await b)!)).toMatchObject({ result: { ok: true } })
    expect(calls).toBe(2)
  } finally {
    release()
    await Promise.allSettled([a, b])
    await server.close()
    await service.close()
  }
})
