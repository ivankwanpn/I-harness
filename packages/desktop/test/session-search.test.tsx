// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SessionSearch } from "../src/renderer/session/SessionSearch.tsx"
afterEach(cleanup)

it("searches within the selected workspace/session and opens a matching conversation", async () => {
  const request = vi.fn(async () => ({ hits: [{ sessionId: "s1", seq: 4, snippet: "找到內容" }], truncated: true }))
  const onSelect = vi.fn()
  render(<SessionSearch bridge={{ request, onEvent: () => () => {} }} workspaceId="playground" sessionId="s1" titles={{ s1: "測試會話" }} onSelect={onSelect} />)
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "內容" } })
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(screen.getByRole("button", { name: "搜尋" }))
  await screen.findByText("找到內容")
  expect(request).toHaveBeenCalledWith({ kind: "desktop/session/search", workspaceId: "playground", sessionId: "s1", query: "內容", limit: 50 })
  expect(screen.getByText("結果已截斷，請縮小搜尋範圍。")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: /測試會話/ }))
  expect(onSelect).toHaveBeenCalledWith({ workspaceId: "playground", sessionId: "s1", seq: 4 })
})
it("rejects pending results after the workspace or session changes", async () => {
  let finish!: (value: unknown) => void
  const request = vi.fn(() => new Promise(resolve => { finish = resolve }))
  const props = { bridge: { request, onEvent: () => () => {} }, titles: {}, onSelect: vi.fn() }
  const view = render(<SessionSearch {...props} workspaceId="a" sessionId="first" />)
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "old" } })
  fireEvent.click(screen.getByRole("button", { name: "搜尋" }))
  view.rerender(<SessionSearch {...props} workspaceId="b" sessionId="second" />)
  await act(async () => { finish({ hits: [{ sessionId: "first", seq: 3, snippet: "stale workspace" }] }) })
  expect(screen.queryByText("stale workspace")).toBeNull()
})

it("does not restore stale results after the query is cleared", async () => {
  let finish!: (value: unknown) => void
  const request = vi.fn(() => new Promise((resolve) => { finish = resolve }))
  render(<SessionSearch bridge={{ request, onEvent: () => () => {} }} workspaceId="playground" titles={{}} onSelect={() => {}} />)
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "舊查詢" } })
  fireEvent.click(screen.getByRole("button", { name: "搜尋" }))
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole("button", { name: "清除搜尋" }))
  await act(async () => { finish({ hits: [{ sessionId: "s1", seq: 1, snippet: "舊結果" }] }) })
  expect(screen.queryByText("舊結果")).toBeNull()
})
