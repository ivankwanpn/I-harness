// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ResourceSettings } from "../src/renderer/settings/ResourceSettings.tsx"
import { MemoryPane } from "../src/renderer/memory/MemoryPane.tsx"
import { HookSettings } from "../src/renderer/settings/HookSettings.tsx"
afterEach(cleanup)

it("keeps a raw skill draft on CAS conflict and confirms local removal", async () => {
  const raw = "---\nname: local\ndescription: Local\n---\nOriginal"
  const request = vi.fn(async row => row.kind.endsWith("list") ? { items: [{ name: "local", source: "workspace" }], total: 1, diagnostics: [] } : { name: "local", source: "workspace", body: "Original", rawBody: raw, revision: "a".repeat(64), truncated: false })
  const author = vi.fn(async (_row: { kind: string }) => ({ kind: "conflict", currentRevision: "b".repeat(64) }))
  render(<ResourceSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="w" resourceKind="skills" onAuthoringRequest={author} />)
  fireEvent.click(await screen.findByRole("button", { name: "local" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯本機內容" }))
  const editor = screen.getByLabelText("完整 Markdown（含 frontmatter）")
  expect((editor as HTMLTextAreaElement).value).toBe(raw)
  fireEvent.change(editor, { target: { value: raw.replace("Original", "Draft") } })
  fireEvent.click(screen.getByRole("button", { name: "儲存資源" }))
  expect(await screen.findByText(/來源已變更/)).toBeTruthy()
  expect((editor as HTMLTextAreaElement).value).toContain("Draft")
  request.mockImplementation(async row => row.kind.endsWith("list") ? { items: [{ name: "local", source: "workspace" }], total: 1, diagnostics: [] } : { name: "local", source: "workspace", body: "External", rawBody: raw.replace("Original", "External"), revision: "b".repeat(64), truncated: false })
  fireEvent.click(screen.getByRole("button", { name: "重新讀取來源以比較" }))
  expect(await screen.findByText((_text, node) => node?.tagName === "PRE" && node.textContent === raw.replace("Original", "External"))).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "保留草稿並採用此來源修訂" }))
  expect((editor as HTMLTextAreaElement).value).toContain("Draft")
  fireEvent.click(screen.getByRole("button", { name: "儲存資源" }))
  await waitFor(() => expect(author).toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/resources/write", expectedRevision: "b".repeat(64), body: raw.replace("Original", "Draft") })))
  fireEvent.click(screen.getByRole("button", { name: "移除本機版本" }))
  expect(author.mock.calls.filter(([row]) => row.kind.endsWith("remove"))).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "確認移除本機版本" }))
  await waitFor(() => expect(author).toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/resources/remove", workspaceId: "w", source: "workspace", name: "local", confirmed: true })))
})

it("ignores completion of a memory edit after changing workspace", async () => {
  const a = { id: "a", title: "Workspace A", text: "A", revision: "a".repeat(64) }, b = { id: "b", title: "Workspace B", text: "B", revision: "b".repeat(64) }
  const request = vi.fn(async row => row.kind.endsWith("state") ? { enabled: true } : row.kind.endsWith("list") ? { notes: [row.workspaceId === "a" ? a : b] } : { note: row.workspaceId === "a" ? a : b })
  let resolve!: (value: unknown) => void
  const pending = new Promise(done => { resolve = done })
  const author = vi.fn(async () => pending)
  const bridge = { request, onEvent: () => () => {} }
  const view = render(<MemoryPane bridge={bridge} workspaceId="a" onAuthoringRequest={author} />)
  fireEvent.click(await screen.findByRole("button", { name: "Workspace A" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯筆記" }))
  fireEvent.change(screen.getByLabelText("內容"), { target: { value: "A draft" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存變更" }))
  view.rerender(<MemoryPane bridge={bridge} workspaceId="b" onAuthoringRequest={author} />)
  await screen.findByRole("button", { name: "Workspace B" })
  await act(async () => { resolve({ kind: "saved", note: { ...a, text: "A saved" } }); await pending })
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.queryByText("A saved")).toBeNull()
  expect(screen.queryByLabelText("內容")).toBeNull()
})

it("keeps hook config edits on conflict and displays the new script digest for explicit config trust review", async () => {
  const config = '{"version":1,"handlers":[]}'
  const request = vi.fn(async () => ({ handlers: [], grants: [], errors: [] }))
  const author = vi.fn(async row => row.kind.endsWith("read-config") ? { body: config, revision: "a".repeat(64) } : row.kind.endsWith("read-script") ? { body: "", revision: null } : row.kind.endsWith("write-script") ? { kind: "saved", revision: "c".repeat(64) } : { kind: "conflict", currentRevision: "b".repeat(64) })
  render(<HookSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="w" onAuthoringRequest={author} />)
  const open = await screen.findByRole("button", { name: "編輯本機 Hooks" })
  await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(open)
  const editor = await screen.findByLabelText("Hooks 設定 JSON")
  fireEvent.change(editor, { target: { value: config + "\n" } })
  fireEvent.click(screen.getByRole("button", { name: "驗證並保存 Hooks" }))
  expect(await screen.findByText(/來源已變更/)).toBeTruthy()
  expect((editor as HTMLTextAreaElement).value).toBe(config + "\n")
  fireEvent.change(screen.getByLabelText("腳本名稱"), { target: { value: "observe" } })
  fireEvent.click(screen.getByRole("button", { name: "讀取或建立腳本" }))
  fireEvent.change(await screen.findByLabelText("Hook 腳本內容"), { target: { value: "console.log('{}')" } })
  fireEvent.click(screen.getByRole("button", { name: "保存腳本" }))
  expect(await screen.findByText("c".repeat(64))).toBeTruthy()
  expect(author).toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/hooks/write-script", workspaceId: "w", name: "observe", expectedRevision: null }))
})

it("preserves memory edits on conflict and requires confirmation for a revision checked batch forget", async () => {
  const note = { id: "n", title: "Title", text: "Original", revision: "a".repeat(64) }
  const request = vi.fn(async row => row.kind.endsWith("state") ? { enabled: true } : row.kind.endsWith("list") ? { notes: [note] } : { note })
  const author = vi.fn(async (_row: { kind: string }) => ({ kind: "conflict", note: { ...note, revision: "b".repeat(64), text: "External" } }))
  render(<MemoryPane bridge={{ request, onEvent: () => () => {} }} workspaceId="w" onAuthoringRequest={author} />)
  fireEvent.click(await screen.findByRole("button", { name: "Title" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯筆記" }))
  fireEvent.change(screen.getByLabelText("內容"), { target: { value: "Draft" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存變更" }))
  expect(await screen.findByText(/筆記已變更/)).toBeTruthy()
  expect((screen.getByLabelText("內容") as HTMLTextAreaElement).value).toBe("Draft")
  fireEvent.click(screen.getByLabelText("選取 Title"))
  fireEvent.click(screen.getByRole("button", { name: "批次刪除（1）" }))
  expect(author.mock.calls.filter(([row]) => row.kind.endsWith("forget-many"))).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "確認刪除選取筆記" }))
  await waitFor(() => expect(author).toHaveBeenCalledWith({ kind: "desktop/memory/forget-many", workspaceId: "w", confirmed: true, targets: [{ id: "n", expectedRevision: note.revision }] }))
})
