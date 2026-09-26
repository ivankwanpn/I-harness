import { it, expect } from "vitest"
import { createDesktopRouter } from "../src/router.ts"
import { createSdkServer } from "@i-harness/sdk/server"
import { createSessionService } from "@i-harness/session-executor"
import { isRpcFailure, isRpcSuccess, type RpcMessage } from "@i-harness/sdk"

it("excludes prompts and duplicate compactions until the compaction has settled", async () => {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(r => { entered = r })
  const gate = new Promise<void>(r => { release = r })
  const frames: RpcMessage[] = []
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", mockScript: [{ role: "assistant", text: "ok" }] })
  const base = createSdkServer(service, { onWrite: f => frames.push(f) })
  const router = createDesktopRouter(base, f => frames.push(f), {
    compact: async () => { entered(); await gate; return { compacted: true } },
  })
  const call = (id: number, method: string, params: unknown) => router.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  try {
    await call(1, "initialize", {})
    const pending = call(2, "desktop/session/compact", { sessionId: "s" })
    await started
    await call(3, "session/prompt", { sessionId: "s", prompt: "must not run" })
    await call(4, "desktop/session/compact", { sessionId: "s" })
    expect(service.hasAssembly("s")).toBe(false)
    for (const id of [3, 4]) {
      const failure = frames.find(f => "id" in f && f.id === id)
      expect(isRpcFailure(failure)).toBe(true)
      if (isRpcFailure(failure)) expect(failure.error.data).toEqual({ reason: "session_busy" })
    }
    let closed = false
    const closing = router.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await pending
    await closing
    expect(isRpcSuccess(frames.find(f => "id" in f && f.id === 2))).toBe(true)
  } finally {
    release()
    await router.close()
    await service.close()
  }
})
