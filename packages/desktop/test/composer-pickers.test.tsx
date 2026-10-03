// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Composer } from "../src/renderer/session/Composer.tsx"
afterEach(() => { cleanup(); localStorage.clear() })
const base = { workspaceId: "picker", sessionId: "s", canSend: true, running: false, onPrompt: vi.fn(async () => {}), onCancel() {} }
it("selects slash commands by keyboard, ignores composition, escapes without submitting", async () => {
  const request = vi.fn(async () => [{ name: "hello" }, { name: "help" }])
  render(<Composer {...base} bridge={{ request, onEvent: () => () => {} }} />)
  const editor = screen.getByRole("textbox", { name: "提示" })
  fireEvent.change(editor, { target: { value: "/he" } })
  await screen.findByText("/hello")
  fireEvent.keyDown(editor, { key: "Enter", isComposing: true })
  expect(base.onPrompt).not.toHaveBeenCalled()
  fireEvent.keyDown(editor, { key: "ArrowDown" })
  fireEvent.keyDown(editor, { key: "Tab" })
  expect((editor as HTMLTextAreaElement).value).toBe("/help ")
  fireEvent.change(editor, { target: { value: "/" } })
  fireEvent.keyDown(editor, { key: "Escape" })
  expect(screen.queryByText("/hello")).toBeNull()
})
it("ignores old workspace picker replies and attaches returned identity with bounded readable data", async () => {
  let finish!: (value: any) => void
  const onPrompt = vi.fn(async (_text: string, _context?: string) => {})
  const request = vi.fn(async (input: any) => input.kind === "desktop/context/read" ? { text: "file body", truncated: false }
    : input.workspaceId === "picker" ? new Promise((resolve) => { finish = resolve }) : { items: [{ kind: "file", workspaceId: "second", path: "notes.md", label: "notes.md" }], nextOffset: null })
  const view = render(<Composer {...base} onPrompt={onPrompt} bridge={{ request, onEvent: () => () => {} }} fileReferencesEnabled />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "@" } })
  await waitFor(() => expect(finish).toBeTruthy())
  view.rerender(<Composer {...base} workspaceId="other" onPrompt={onPrompt} bridge={{ request, onEvent: () => () => {} }} fileReferencesEnabled />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "@notes" } })
  await screen.findByText("second/notes.md")
  await act(async () => finish({ items: [{ kind: "file", workspaceId: "picker", path: "stale.md", label: "stale.md" }], nextOffset: null }))
  expect(screen.queryByText("picker/stale.md")).toBeNull()
  fireEvent.keyDown(screen.getByRole("textbox", { name: "提示" }), { key: "Enter" })
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(onPrompt).toHaveBeenCalled())
  expect(onPrompt.mock.calls[0]?.[1]).toContain("file body")
  expect(onPrompt.mock.calls[0]?.[1]).toContain('"workspaceId":"second"')
})
it("shows empty results and effective permissions, keeping a rejected permission selection explicit", async () => {
  const state = { saved: { sandboxMode: "read-only", approvalMode: "ask-all", autoCompaction: true }, effective: { sandboxMode: "read-only", approvalMode: "ask-all", autoCompaction: true }, restartRequired: false }
  const request = vi.fn(async (input: any) => { if (input.kind.endsWith("configure")) throw new Error("read-only policy rejects change"); return input.kind.endsWith("search") ? { items: [], nextOffset: null } : state })
  render(<Composer {...base} bridge={{ request, onEvent: () => () => {} }} fileReferencesEnabled permissionsEnabled />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "@none" } })
  await screen.findByText("沒有符合的引用")
  fireEvent.keyDown(screen.getByRole("textbox", { name: "提示" }), { key: "Escape" })
  fireEvent.click(screen.getByRole("button", { name: /權限/ }))
  await screen.findByText("read-only · ask-all")
  fireEvent.change(screen.getByRole("combobox", { name: "沙箱" }), { target: { value: "workspace-write" } })
  await screen.findByText("read-only policy rejects change")
  expect((screen.getByRole("combobox", { name: "沙箱" }) as HTMLSelectElement).value).toBe("read-only")
})
