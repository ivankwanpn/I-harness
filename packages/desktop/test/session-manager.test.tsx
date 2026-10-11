// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { SessionManager } from "../src/renderer/session/SessionManager.tsx"
import { SessionManagerMenu } from "../src/renderer/session/SessionManagerMenu.tsx"
import { SettingsDialog } from "../src/renderer/settings/SettingsDialog.tsx"
afterEach(cleanup)
async function chooseConversationAction(title: string, action: string) {
  fireEvent.click(await screen.findByRole("button", { name: `更多會話操作 ${title}` }))
  fireEvent.click(screen.getByRole("menuitem", { name: action }))
}

it("gives a conversation menu keyboard and composition-safe Escape ownership before returning focus", async () => {
  const bridge = { request: async () => ({ sessions: [{ id: "owned-session-id", title: "First" }] }), onEvent: () => () => {} }
  render(<SettingsDialog title="Manager" closeLabel="Close manager" initialFocusSelector="button" onClose={() => {}}><SessionManager workspaceId="w" bridge={bridge} onManage={async () => {}} /></SettingsDialog>)
  const trigger = await screen.findByRole("button", { name: "更多會話操作 First" })
  expect(screen.queryByText("owned-session-id")).toBeNull()
  fireEvent.click(trigger)
  const menu = screen.getByRole("menu")
  expect(screen.getByText("owned-session-id")).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "重新命名" }))
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "建立分支" }))
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" })
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "重新命名" }))
  fireEvent.keyDown(document.activeElement!, { key: "End" })
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "封存會話" }))
  fireEvent.compositionStart(menu)
  fireEvent.keyDown(menu, { key: "Escape", isComposing: true })
  expect(screen.getByRole("menu")).toBe(menu)
  fireEvent.compositionEnd(menu)
  fireEvent.keyUp(menu, { key: "Escape" })
  fireEvent.keyDown(menu, { key: "Escape" })
  expect(screen.queryByRole("menu")).toBeNull()
  expect(screen.getByRole("dialog", { name: "Manager" })).toBeTruthy()
  expect(document.activeElement).toBe(trigger)
})

it("keeps the 100-session batch bound across pages and permits a fresh selection after clearing it", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ id: `s${index}`, title: `Session ${index}` }))
  const selected = rows.slice(0, 100).map(row => row.id)
  const batch = vi.fn(async () => ({ results: [{ sessionId: "s100", ok: true as const }] }))
  render(<SessionManager workspaceId="w" initialSelected={selected} bridge={{ request: async () => ({ sessions: rows }), onEvent: () => () => {} }} onManage={async () => {}} onBatch={batch} />)
  await screen.findByRole("checkbox", { name: "選取 Session 0" })
  fireEvent.click(screen.getByRole("button", { name: "下一頁" }))
  fireEvent.click(screen.getByRole("button", { name: "下一頁" }))
  const last = screen.getByRole("checkbox", { name: "選取 Session 100" }) as HTMLInputElement
  expect(last.disabled).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "取消選取" }))
  expect(last.disabled).toBe(false)
  fireEvent.click(last)
  fireEvent.click(screen.getByRole("button", { name: "封存所選會話" }))
  fireEvent.click(screen.getByRole("button", { name: "確認批次封存" }))
  await waitFor(() => expect(batch).toHaveBeenCalledWith({ action: "archive", sessionIds: ["s100"] }))
})

it.each(["single", "batch"] as const)("ignores a stale %s failure after the manager scope changes A → B → A", async kind => {
  const pending = Promise.withResolvers<void>()
  const request = async (input: { kind: string; workspaceId?: string }) => ({ sessions: [{ id: "same-id", title: `Conversation ${input.workspaceId}` }] })
  const props = {
    bridge: { request, onEvent: () => () => {} },
    onManage: async () => pending.promise,
    onBatch: async () => { await pending.promise; return { results: [] } },
  }
  const { rerender } = render(<SessionManager {...props} workspaceId="A" />)
  if (kind === "single") await chooseConversationAction("Conversation A", "建立分支")
  else {
    fireEvent.click(await screen.findByRole("checkbox", { name: "選取 Conversation A" }))
    fireEvent.click(screen.getByRole("button", { name: "封存所選會話" }))
    fireEvent.click(screen.getByRole("button", { name: "確認批次封存" }))
  }
  await waitFor(() => expect((screen.getByRole("button", { name: "更多會話操作 Conversation A", hidden: true }) as HTMLButtonElement).disabled).toBe(true))
  rerender(<SessionManager {...props} workspaceId="B" />)
  await screen.findByRole("heading", { name: "Conversation B" })
  rerender(<SessionManager {...props} workspaceId="A" />)
  await screen.findByRole("heading", { name: "Conversation A" })
  await act(async () => { pending.reject(new Error("Old scope failure")); await pending.promise.catch(() => {}) })
  expect(screen.queryByRole("alert")).toBeNull()
  expect((screen.getByRole("button", { name: "更多會話操作 Conversation A" }) as HTMLButtonElement).disabled).toBe(false)
})

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
  const second = await screen.findByRole("button", { name: "更多會話操作 Second" })
  await chooseConversationAction("First", "回復會話")
  await screen.findByRole("option", { name: "1 · Before work" })
  fireEvent.change(screen.getByRole("combobox", { name: "回復點" }), { target: { value: "0" } })
  fireEvent.click(screen.getByRole("button", { name: "預覽回復" }))
  fireEvent.click(await screen.findByRole("checkbox", { name: "我已查看影響範圍並確認回復" }))
  fireEvent.click(screen.getByRole("button", { name: "確認回復" }))
  await waitFor(() => expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true"))
  expect((second as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(second)
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
  const trigger = screen.getByRole("button", { name: "目的專案" })
  fireEvent.click(trigger)
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "未分組" }))
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Destination" }))
  fireEvent.click(document.activeElement!)
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Destination" }))
  fireEvent.keyDown(document.activeElement!, { key: "Escape" })
  expect(screen.queryByRole("menu")).toBeNull()
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(screen.getByRole("button", { name: "移動所選會話" }))
  expect(screen.getByRole("dialog").textContent).toContain("D:/source")
  expect(batch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "確認移動" }))
  await waitFor(() => expect(batch).toHaveBeenCalledWith({ action: "move", sessionIds: ["a"], projectId: "p2", expectedOwners: { a: "p1" } }))
})
it.each([
  { label: "one project remains", remaining: [{ id: "remaining", name: "Remaining" }], next: "Remaining" },
  { label: "no projects remain", remaining: [], next: "未分組" },
])("keeps keyboard selection reachable when the selected destination disappears ($label)", async ({ remaining, next }) => {
  const props = {
    workspaceId: "w",
    bridge: { request: async () => ({ sessions: [{ id: "a", title: "First" }] }), onEvent: () => () => {} },
    onManage: async () => {},
    onBatch: async () => ({ results: [] }),
    currentOwners: { a: "source" },
    executionWorkspace: "D:/source",
  }
  const { rerender } = render(<SessionManager {...props} projects={[{ id: "removed", name: "Destination" }, ...remaining]} />)
  await screen.findByRole("heading", { name: "First" })
  const trigger = screen.getByRole("button", { name: "目的專案" })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Destination" }))
  expect(document.activeElement).toBe(trigger)
  rerender(<SessionManager {...props} projects={remaining} />)
  fireEvent.click(trigger)
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "未分組" }))
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: next }))
  fireEvent.click(document.activeElement!)
  expect(screen.queryByRole("menu")).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(trigger.textContent).toContain(next)
})
it("focuses the first enabled menu choice when the preferred choice is disabled", () => {
  function Fixture() {
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
    return <><button ref={setAnchor}>Open owned menu</button>{anchor ? <SessionManagerMenu id="owned-menu" label="Owned menu" anchor={anchor} initialFocusSelector='[aria-checked="true"]' onClose={() => {}}>
      <button type="button" role="menuitemradio" aria-checked="true" disabled>Unavailable choice</button>
      <button type="button" role="menuitemradio" aria-checked="false">First enabled choice</button>
      <button type="button" role="menuitemradio" aria-checked="false">Second enabled choice</button>
    </SessionManagerMenu> : null}</>
  }
  render(<Fixture />)
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "First enabled choice" }))
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Second enabled choice" }))
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "First enabled choice" }))
})
it("requires confirmation to archive and reads a separate restore list", async () => {
  const request = vi.fn(async (value) => value.kind === "session/list" ? { sessions: [{ id: "s", title: "Example" }] } : [{ id: "s", title: "Example" }])
  const manage = vi.fn().mockResolvedValue(undefined)
  render(<SessionManager workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onManage={manage} />)
  await chooseConversationAction("Example", "封存會話")
  expect(manage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "確認封存" }))
  await waitFor(() => expect(manage).toHaveBeenCalledWith("s", "archive", undefined))
  await waitFor(() => expect((screen.getByRole("button", { name: "已封存會話" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "已封存會話" }))
  await chooseConversationAction("Example", "還原會話")
  await waitFor(() => expect(manage).toHaveBeenCalledWith("s", "restore", undefined))
})
it("keeps the proposed name when saving fails", async () => {
  const request = vi.fn().mockResolvedValue({ sessions: [{ id: "s", title: "Old" }] })
  render(<SessionManager workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onManage={async () => { throw new Error("busy") }} />)
  await chooseConversationAction("Old", "重新命名")
  fireEvent.change(screen.getByLabelText("會話名稱"), { target: { value: "New" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByRole("alert")
  expect((screen.getByLabelText("會話名稱") as HTMLInputElement).value).toBe("New")
})
it("starts a fresh rename after cancelling an IME composition draft", async () => {
  let name = "Old"
  const manage = vi.fn(async (_id: string, _action: string, title?: string) => { name = title ?? name })
  const request = async () => ({ sessions: [{ id: "s", title: name }] })
  render(<SessionManager workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onManage={manage} />)
  await chooseConversationAction("Old", "重新命名")
  fireEvent.compositionStart(screen.getByLabelText("會話名稱"))
  fireEvent.click(screen.getByRole("button", { name: "取消" }))
  await chooseConversationAction("Old", "重新命名")
  fireEvent.change(screen.getByLabelText("會話名稱"), { target: { value: "New" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(await screen.findByRole("heading", { name: "New" })).toBeTruthy()
  expect(manage).toHaveBeenCalledWith("s", "rename", "New")
})
