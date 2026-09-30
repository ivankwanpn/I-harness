// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { operationKey, useSessionOperation } from "../src/renderer/session/use-session-operation.ts"
afterEach(cleanup)

it("releases durable sends at admission and permits a second queued input from the same window", async () => {
  const request = vi.fn().mockResolvedValue({ accepted: true, inputId: "durable-one" })
  const admitted = vi.fn()
  const view = renderHook(() => useSessionOperation({ request, onEvent: () => () => {} }, true))
  await act(async () => { await view.result.current.run("w", "a", "prompt", "first", undefined, undefined, admitted) })
  expect(admitted).toHaveBeenCalledOnce()
  expect(view.result.current.states[operationKey("w", "a")]?.busy).toBe(false)
  await act(async () => { await view.result.current.run("w", "a", "prompt", "second", undefined, undefined, undefined, "steer") })
  expect(request.mock.calls[0]?.[0]).toMatchObject({ kind: "desktop/session/input/submit", text: "first", delivery: "queue" })
  expect(request.mock.calls[1]?.[0]).toMatchObject({ kind: "desktop/session/input/submit", text: "second", delivery: "steer" })
})

it("keeps an unaccepted draft when durable persistence fails after an in-memory admission", async () => {
  let reject!: (error: Error) => void
  const admitted = vi.fn()
  const listeners: ((event: unknown) => void)[] = []
  const request = vi.fn((_request: unknown) => new Promise((_done, fail) => { reject = fail }))
  const bridge = { request, onEvent: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {} } }
  const view = renderHook(() => useSessionOperation(bridge as never, true))
  let pending!: Promise<unknown>
  act(() => { pending = view.result.current.run("w", "s", "prompt", "retain me", undefined, undefined, admitted) })
  const token = (request.mock.calls[0]![0] as { clientToken: string }).clientToken
  act(() => listeners.forEach((emit) => emit({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId: "s", event: { type: "agent/input/admitted", intent: "user", delivery: "queue", clientToken: token } } })))
  expect(admitted).not.toHaveBeenCalled()
  await act(async () => { reject(new Error("disk full")); await expect(pending).rejects.toThrow("disk full") })
  expect(admitted).not.toHaveBeenCalled()
})

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

it("reports prompt admission before a later model error without accepting another session's event", async () => {
  let reject!: (reason: Error) => void
  let emit!: (event: unknown) => void
  const onAdmitted = vi.fn()
  const request = vi.fn((_request: unknown) => new Promise((_resolve, fail) => { reject = fail }))
  const bridge = { request, onEvent: (listener: (event: unknown) => void) => { emit = listener; return () => {} } }
  const view = renderHook(() => useSessionOperation(bridge as never))
  let pending!: Promise<unknown>
  act(() => { pending = view.result.current.run("w", "a", "prompt", "read file", undefined, undefined, onAdmitted) })
  const token = (request.mock.calls[0]![0] as { clientToken?: string }).clientToken
  expect(typeof token).toBe("string")
  act(() => emit({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId: "b", event: { type: "agent/input/admitted", text: "read file", intent: "user", delivery: "queue" } } }))
  expect(onAdmitted).not.toHaveBeenCalled()
  act(() => emit({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId: "a", event: { type: "agent/input/admitted", text: "system note", intent: "system", delivery: "queue" } } }))
  expect(onAdmitted).not.toHaveBeenCalled()
  act(() => emit({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId: "a", event: { type: "agent/input/admitted", text: "other request", intent: "user", delivery: "queue", clientToken: "other-token" } } }))
  expect(onAdmitted).not.toHaveBeenCalled()
  act(() => emit({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId: "a", event: { type: "agent/input/admitted", text: "read file", intent: "user", delivery: "queue", clientToken: token } } }))
  expect(onAdmitted).toHaveBeenCalledOnce()
  await act(async () => { reject(new Error("provider 400")); await expect(pending).rejects.toThrow("provider 400") })
})

it("acknowledges a prompt whose file context was appended before admission", async () => {
  let reject!: (reason: Error) => void
  let emit!: (event: unknown) => void
  const onAdmitted = vi.fn()
  const request = vi.fn((_request: unknown) => new Promise((_resolve, fail) => { reject = fail }))
  const bridge = {
    request,
    onEvent: (listener: (event: unknown) => void) => { emit = listener; return () => {} },
  }
  const view = renderHook(() => useSessionOperation(bridge as never))
  let pending!: Promise<unknown>
  act(() => { pending = view.result.current.run("w", "a", "prompt", "read file", 'Workspace refs: ["a.md"]', undefined, onAdmitted) })
  const token = (request.mock.calls[0]![0] as { clientToken?: string }).clientToken
  act(() => emit({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId: "a", event: { type: "agent/input/admitted", text: 'read file\n\nWorkspace refs: ["a.md"]', intent: "user", delivery: "queue", clientToken: token } } }))
  expect(onAdmitted).toHaveBeenCalledOnce()
  await act(async () => { reject(new Error("provider 400")); await expect(pending).rejects.toThrow("provider 400") })
})
