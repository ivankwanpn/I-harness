import { it, expect } from "vitest"
import { createDesktopRouter } from "../src/router.ts"
import { createSdkServer } from "@i-harness/sdk/server"
import { createSessionService } from "@i-harness/session-executor"
import { isRpcFailure, isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import type { TaskProjectionIssue } from "@i-harness/subagent"

it("routes desktop/session/tasks/integrity to the host projection handler", async () => {
  const frames: RpcMessage[] = []
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", mockScript: [{ role: "assistant", text: "ok" }] })
  const base = createSdkServer(service, { onWrite: frame => frames.push(frame) })
  const calls: { sessionId: string; options: { reconcile?: boolean } }[] = []
  const issues: TaskProjectionIssue[] = [{ kind: "missing-child-session", taskId: "t1", childSessionId: "c1" }]
  const router = createDesktopRouter(base, frame => frames.push(frame), {
    taskProjection: async (sessionId, options) => {
      calls.push({ sessionId, options })
      return issues
    },
  })
  const call = (id: number, method: string, params: unknown) => router.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  try {
    await call(1, "initialize", {})
    await call(2, "desktop/session/tasks/integrity", { sessionId: "s", reconcile: true })
    expect(calls).toEqual([{ sessionId: "s", options: { reconcile: true } }])
    const success = frames.find(frame => "id" in frame && frame.id === 2)
    expect(isRpcSuccess(success)).toBe(true)
    if (isRpcSuccess(success)) expect(success.result).toEqual(issues)

    await call(3, "desktop/session/tasks/integrity", { sessionId: "s", reconcile: "yes" })
    const failure = frames.find(frame => "id" in frame && frame.id === 3)
    expect(isRpcFailure(failure)).toBe(true)
  } finally {
    await router.close()
    await service.close()
  }
})
