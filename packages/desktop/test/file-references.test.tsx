// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Composer } from "../src/renderer/session/Composer.tsx"
import { readFileReferences, writeFileReferences } from "../src/renderer/session/file-reference-drafts.ts"
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })
it("keeps references in memory when storage writes fail but reads still work", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota") })
  writeFileReferences("quota-w", "quota-s", ["a.md"])
  expect(readFileReferences("quota-w", "quota-s")).toEqual(["a.md"])
})
it("keeps selected file references on failure and clears them only after a confirmed send", async () => {
  const request = vi.fn(async (request) => request.kind === "workspace/attachments/pick" ? { paths: ["src/a.ts", "README.md"], images: [], texts: [] } : [])
  const onPrompt = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined)
  render(<Composer workspaceId="files-w" sessionId="files-s" bridge={{ request, onEvent: () => () => {} }} fileReferencesEnabled canSend running={false} onPrompt={onPrompt} onCancel={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "新增附件" }))
  await screen.findByText("src/a.ts")
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "Check these" } })
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await screen.findByText("offline")
  expect(screen.getByText("src/a.ts")).toBeTruthy()
  expect(onPrompt.mock.calls[0]![0]).toBe("Check these")
  expect(onPrompt.mock.calls[0]![1]).toContain('"src/a.ts"')
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(screen.queryByText("src/a.ts")).toBeNull())
})

it("keeps a late picker result with its original session", async () => {
  let finish!: (value: unknown) => void
  const request = vi.fn(() => new Promise((resolve) => { finish = resolve }))
  const props = { workspaceId: "late-w", sessionId: "a", bridge: { request, onEvent: () => () => {} }, fileReferencesEnabled: true, canSend: true, running: false, onPrompt: async () => {}, onCancel: () => {} }
  const view = render(<Composer {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "新增附件" }))
  view.rerender(<Composer {...props} sessionId="b" />)
  await act(async () => finish({ paths: ["late.md"], images: [], texts: [] }))
  expect(screen.queryByText("late.md")).toBeNull()
  view.rerender(<Composer {...props} />)
  expect(screen.getByText("late.md")).toBeTruthy()
})
