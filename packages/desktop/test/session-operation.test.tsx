// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { operationKey, useSessionOperation } from "../src/renderer/session/use-session-operation.ts"
afterEach(cleanup)

it("owns pending operations by session and rejects a second operation in that session", async () => {
  let resolve!: (value: unknown) => void
  const request = vi.fn(() => new Promise((done) => { resolve = done }))
  const view = renderHook(() => useSessionOperation({ request, onEvent: () => () => {} }))
  let pending!: Promise<unknown>
  act(() => { pending = view.result.current.run("w", "a", "compact", "保留結論") })
  expect(view.result.current.states[operationKey("w", "a")]?.busy).toBe(true)
  expect(view.result.current.states[operationKey("w", "b")]).toBeUndefined()
  await expect(view.result.current.run("w", "a", "prompt", "duplicate")).rejects.toThrow("Session is busy")
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => { resolve({ compacted: true, summary: "摘要", shadowedSeqs: [1] }); await pending })
  expect(view.result.current.states[operationKey("w", "a")]).toMatchObject({ busy: false, result: { compacted: true, summary: "摘要" } })
  expect(request).toHaveBeenCalledWith({ kind: "desktop/session/compact", workspaceId: "w", sessionId: "a", instructions: "保留結論" })
})

it("records a failure and releases the session for retry", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("cancelled")).mockResolvedValueOnce({ compacted: false, shadowedSeqs: [] })
  const view = renderHook(() => useSessionOperation({ request, onEvent: () => () => {} }))
  await act(async () => { await expect(view.result.current.run("w", "a", "compact")).rejects.toThrow("cancelled") })
  expect(view.result.current.states[operationKey("w", "a")]).toMatchObject({ busy: false, error: "cancelled" })
  await act(async () => { await view.result.current.run("w", "a", "compact", "  ") })
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/session/compact", workspaceId: "w", sessionId: "a" })
})
