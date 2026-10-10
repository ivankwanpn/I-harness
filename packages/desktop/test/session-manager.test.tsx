// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { SessionManager } from "../src/renderer/session/SessionManager.tsx"
import { SettingsDialog } from "../src/renderer/settings/SettingsDialog.tsx"
afterEach(cleanup)
it("keeps pending rewind ownership and blocks replacing it through another manager row", async () => {
  let finish!: (value: unknown) => void
  const execution = new Promise(resolve => { finish = resolve })
  const request = vi.fn(async (input: { kind: string }) => {
    if (input.kind === "session/list") return { sessions: [{ id: "a", title: "First" }, { id: "b", title: "Second" }] }
    if (input.kind === "desktop/rewind/points") return [{ turnIndex: 0, preview: "Before work", files: 1 }]
    if (input.kind === "desktop/rewind/plan") return { fingerprint: "fixture", ops: [], conflicts: [], unTracked: [] }
    if (input.kind === "desktop/rewind/execute") return execution
  })
  const bridge = { request, onEvent: () => () => {} }
  function Fixture() {
    const [busy, setBusy] = useState(false), [open, setOpen] = useState(true)
    return open ? <SettingsDialog title="Manager" closeLabel="Close manager" initialFocusSelector="button" busy={busy} onClose={() => setOpen(false)}><SessionManager workspaceId="w" bridge={bridge} onManage={async () => {}} onRewindComplete={() => {}} onBusyChange={setBusy} /></SettingsDialog> : null
  }
  render(<Fixture />)
  const rows = await screen.findAllByRole("button", { name: "回復會話" })
  fireEvent.click(rows[0]!)
  await screen.findByRole("option", { name: "1 · Before work" })
  fireEvent.change(screen.getByRole("combobox", { name: "回復點" }), { target: { value: "0" } })
  fireEvent.click(screen.getByRole("button", { name: "預覽回復" }))
  fireEvent.click(await screen.findByRole("checkbox", { name: "我已查看影響範圍並確認回復" }))
  fireEvent.click(screen.getByRole("button", { name: "確認回復" }))
  await waitFor(() => expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true"))
  expect((rows[1] as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(rows[1]!)
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.getByRole("dialog")).toBeTruthy()
  expect(request.mock.calls.filter(([input]) => input.kind === "desktop/rewind/points")).toHaveLength(1)
  await act(async () => { finish({ revertedFiles: 0, errors: [], eventAppended: true }); await execution })
})
it("shows pending list loading and gives the shared batch dialog IME Escape ownership", async () => {
  let finish!: (value: unknown) => void
  const rows = new Promise(resolve => { finish = resolve })
  render(<SessionManager workspaceId="w" bridge={{ request: async () => rows, onEvent: () => () => {} }} onManage={async () => {}} onBatch={async () => ({ results: [] })} />)
  expect(screen.getByRole("status").textContent).toContain("正在讀取")
  expect(screen.queryByText("尚無會話")).toBeNull()
  finish({ sessions: [{ id: "a", title: "First" }] })
  fireEvent.click(await screen.findByRole("checkbox", { name: "選取 First" }))
  fireEvent.click(screen.getByRole("button", { name: "封存所選會話" }))
  const dialog = screen.getByRole("dialog")
  fireEvent.compositionStart(dialog)
  fireEvent.keyDown(dialog, { key: "Escape", isComposing: true })
  expect(screen.getByRole("dialog")).toBe(dialog)
})
it("offers exact native cleanup retry after a deleted session disappears from the list", async () => {
  let deleted = false
  const request = async () => ({ sessions: deleted ? [] : [{ id: "a", title: "Delete me" }] })
  const batch = vi.fn().mockImplementationOnce(async () => { deleted = true; return { results: [{ sessionId: "a", ok: false, sessionDeleted: true, error: "Native draft cleanup failed" }] } }).mockResolvedValueOnce({ results: [{ sessionId: "a", ok: true }] })
  render(<SessionManager workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onManage={async () => {}} onBatch={batch} />)
  fireEvent.click(await screen.findByRole("checkbox", { name: "選取 Delete me" })); fireEvent.click(screen.getByRole("button", { name: "永久刪除所選會話" })); fireEvent.click(screen.getByRole("button", { name: "確認永久刪除" }))
  await screen.findByText(/Native draft cleanup failed/); await screen.findByText("尚無會話")
  expect(screen.getByText("a · 會話已刪除，本機草稿尚未清理。")).toBeTruthy()
  const diagnostic = screen.getByText("詳細錯誤").closest("details")!
  expect(diagnostic.open).toBe(false)
  fireEvent.click(screen.getByText("詳細錯誤"))
  expect(diagnostic.textContent).toContain("Native draft cleanup failed")
  fireEvent.click(screen.getByRole("button", { name: "重試草稿清理" }))
  await waitFor(() => expect(batch).toHaveBeenCalledTimes(2)); expect(batch).toHaveBeenLastCalledWith({ action: "delete", sessionIds: ["a"] })
})
it("bounds mounted session rows while batch selection remains explicit across pages", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({ id: `s${index}`, title: `Session ${index}` }))
  const batch = vi.fn(async () => ({ results: [{ sessionId: "s0", ok: true as const }, { sessionId: "s50", ok: true as const }] }))
  render(<SessionManager workspaceId="w" bridge={{ request: async () => ({ sessions: rows }), onEvent: () => () => {} }} onManage={async () => {}} onBatch={batch} />)
  fireEvent.click(await screen.findByRole("checkbox", { name: "選取 Session 0" }))
  expect(screen.getAllByRole("checkbox")).toHaveLength(50)
  fireEvent.click(screen.getByRole("button", { name: "下一頁" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "選取 Session 50" }))
  expect(screen.getAllByRole("checkbox")).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "封存所選會話" }))
  fireEvent.click(screen.getByRole("button", { name: "確認批次封存" }))
  await waitFor(() => expect(batch).toHaveBeenCalledWith({ action: "archive", sessionIds: ["s0", "s50"] }))
})
it("confirms explicit batch IDs, reports partial failures, and retains failed selections", async () => {
  const request = vi.fn(async () => ({ sessions: [{ id: "a", title: "First" }, { id: "b", title: "Busy" }] }))
  const batch = vi.fn(async () => ({ results: [{ sessionId: "a", ok: true as const }, { sessionId: "b", ok: false as const, error: "pending input" }] }))
  render(<SessionManager workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onManage={async () => {}} onBatch={batch} />)
  fireEvent.click(await screen.findByRole("checkbox", { name: "選取 First" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "選取 Busy" }))
  fireEvent.click(screen.getByRole("button", { name: "永久刪除所選會話" }))
  expect(batch).not.toHaveBeenCalled()
  expect(screen.getByRole("dialog").textContent).toContain("First")
  fireEvent.click(screen.getByRole("button", { name: "確認永久刪除" }))
  await waitFor(() => expect(batch).toHaveBeenCalledWith({ action: "delete", sessionIds: ["a", "b"] }))
  expect(await screen.findByText(/pending input/)).toBeTruthy()
  expect((screen.getByRole("checkbox", { name: "選取 Busy" }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole("checkbox", { name: "選取 First" }) as HTMLInputElement).checked).toBe(false)
})
it("discloses retained execution folder and commits move with the expected owner", async () => {
  const request = vi.fn(async () => ({ sessions: [{ id: "a", title: "First" }] }))
  const batch = vi.fn(async () => ({ results: [{ sessionId: "a", ok: true as const, projectId: "p2", executionWorkspace: "D:/source" }] }))
  render(<SessionManager workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onManage={async () => {}} onBatch={batch} projects={[{ id: "p2", name: "Destination" }]} currentOwners={{ a: "p1" }} executionWorkspace="D:/source" />)
  fireEvent.click(await screen.findByRole("checkbox", { name: "選取 First" }))
  fireEvent.change(screen.getByLabelText("目的專案"), { target: { value: "p2" } })
  fireEvent.click(screen.getByRole("button", { name: "移動所選會話" }))
  expect(screen.getByRole("dialog").textContent).toContain("D:/source")
  expect(batch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "確認移動" }))
  await waitFor(() => expect(batch).toHaveBeenCalledWith({ action: "move", sessionIds: ["a"], projectId: "p2", expectedOwners: { a: "p1" } }))
})
it("requires confirmation to archive and reads a separate restore list", async () => {
  const request = vi.fn(async (value) => value.kind === "session/list" ? { sessions: [{ id: "s", title: "Example" }] } : [{ id: "s", title: "Example" }])
  const manage = vi.fn().mockResolvedValue(undefined)
  render(<SessionManager workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onManage={manage} />)
  fireEvent.click(await screen.findByRole("button", { name: "封存會話" }))
  expect(manage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "確認封存" }))
  await waitFor(() => expect(manage).toHaveBeenCalledWith("s", "archive", undefined))
  await waitFor(() => expect((screen.getByRole("button", { name: "已封存會話" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "已封存會話" }))
  fireEvent.click(await screen.findByRole("button", { name: "還原會話" }))
  await waitFor(() => expect(manage).toHaveBeenCalledWith("s", "restore", undefined))
})
it("keeps the proposed name when saving fails", async () => {
  const request = vi.fn().mockResolvedValue({ sessions: [{ id: "s", title: "Old" }] })
  render(<SessionManager workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onManage={async () => { throw new Error("busy") }} />)
  fireEvent.click(await screen.findByRole("button", { name: "重新命名" }))
  fireEvent.change(screen.getByLabelText("會話名稱"), { target: { value: "New" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByRole("alert")
  expect((screen.getByLabelText("會話名稱") as HTMLInputElement).value).toBe("New")
})
