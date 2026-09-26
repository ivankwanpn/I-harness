// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { usePendingInteractions } from "../src/renderer/interaction/use-pending-interactions.ts"
import type { PendingInteraction } from "../src/renderer/interaction/pending.ts"
afterEach(cleanup)
const row = (requestId: string): PendingInteraction => ({ requestId, sessionId: "s", kind: "approval", payload: {}, openedAt: 1 })
it("keeps live additions and does not resurrect closed requests from a delayed snapshot", async () => {
  let resolve!: (value: unknown) => void
  const bridge = { request: () => new Promise((done) => { resolve = done }), onEvent: () => () => {} }
  const view = renderHook(() => usePendingInteractions(bridge, "playground"))
  act(() => view.result.current.update("old", row("old")))
  let refresh!: Promise<void>
  act(() => { refresh = view.result.current.refresh() })
  act(() => { view.result.current.update("old"); view.result.current.update("new", row("new")) })
  await act(async () => { resolve([row("old")]); await refresh })
  expect(view.result.current.pending.map((item) => item.requestId)).toEqual(["new"])
})
it("ignores a snapshot after the workspace changes", async () => {
  let resolve!: (value: unknown) => void
  const bridge = { request: () => new Promise((done) => { resolve = done }), onEvent: () => () => {} }
  const view = renderHook(({ workspace }) => usePendingInteractions(bridge, workspace), { initialProps: { workspace: "a" } })
  let refresh!: Promise<void>
  act(() => { refresh = view.result.current.refresh() })
  view.rerender({ workspace: "b" })
  await act(async () => { resolve([row("old")]); await refresh })
  expect(view.result.current.pending).toEqual([])
})
