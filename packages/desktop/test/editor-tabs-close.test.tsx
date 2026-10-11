// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { EditorTabs } from "../src/renderer/review/EditorTabs.tsx"
import { EditorDraftStore, isDraftDirty } from "../src/renderer/review/editor-drafts.ts"
import { useState } from "react"
import type { ProjectFileRef } from "../../desktop-gateway/src/project-files.ts"

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const roots = [{ workspaceId: "one", label: "app" }, { workspaceId: "two", label: "shared" }]
const ref = (path: string, workspaceId = "one"): ProjectFileRef => ({ workspaceId, path })
function open(store: EditorDraftStore, file: ProjectFileRef, dirty = false) {
  store.open(file)
  store.ingest(file, { kind: "text", text: "original", revision: "a".repeat(64), bytes: 8, truncated: false })
  if (dirty) store.edit(file, "changed")
}
const saved = (store: EditorDraftStore) => async (file: ProjectFileRef) => (await store.save(file, async text => ({ kind: "saved", revision: "b".repeat(64), bytes: text.length }))).kind === "saved"

it("shows basename tabs with full accessible identity and visible close controls without opaque removed-root IDs", () => {
  const store = new EditorDraftStore()
  open(store, ref("src/same.ts"), true)
  open(store, ref("src/same.ts", "removed-uuid"))
  render(<EditorTabs roots={roots} rootLabels={{ "removed-uuid": "old-folder" }} store={store} onSave={saved(store)} />)
  expect(screen.getByRole("tab", { name: "app/src/same.ts ●" }).textContent).toBe("same.ts")
  expect(screen.getByRole("tab", { name: "old-folder/src/same.ts" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "關閉 app/src/same.ts" }).className).toContain("editor-tab-close")
  expect(screen.queryByRole("button", { name: "關閉全部" })).toBeNull()
  expect(screen.queryByRole("button", { name: "關閉檔案" })).toBeNull()
  expect(screen.queryByRole("button", { name: "檔案分頁操作" })).toBeNull()
  expect(screen.queryByRole("button", { name: "關閉其他" })).toBeNull()
  expect(screen.queryByText(/removed-uuid/)).toBeNull()
})

it("closes a clean active tab and selects its next neighbor rather than the last tab", () => {
  const store = new EditorDraftStore()
  for (const path of ["a.ts", "b.ts", "c.ts", "d.ts"]) open(store, ref(path))
  store.open(ref("b.ts"))
  render(<EditorTabs roots={roots} store={store} onSave={saved(store)} />)
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/b.ts" }))
  expect(store.getSnapshot().active).toEqual(ref("c.ts"))
  expect(store.getSnapshot().tabs.map(file => file.path)).toEqual(["a.ts", "c.ts", "d.ts"])
})

it.each([false, true])("restores keyboard focus after closing an inactive tab (dirty: %s)", dirty => {
  const store = new EditorDraftStore()
  open(store, ref("a.ts"), dirty); open(store, ref("b.ts"))
  render(<EditorTabs roots={roots} store={store} onSave={saved(store)} />)
  const close = screen.getByRole("button", { name: "關閉 app/a.ts" })
  close.focus(); fireEvent.click(close)
  if (dirty) fireEvent.click(screen.getByRole("button", { name: "保留草稿並關閉" }))
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "app/b.ts" }))
  expect(store.getSnapshot().active).toEqual(ref("b.ts"))
})

it("restores keyboard focus to the underlying tab after closing an external preview", () => {
  const store = new EditorDraftStore(); open(store, ref("a.ts"))
  function Harness() {
    const [external, setExternal] = useState(true)
    return <EditorTabs roots={roots} store={store} onSave={saved(store)} externalTab={external ? { path: "D:/reference.md", onClose: () => setExternal(false) } : undefined} />
  }
  render(<Harness />)
  const tab = screen.getByRole("tab", { name: "D:/reference.md" }); tab.focus()
  fireEvent.keyDown(tab, { key: "w", ctrlKey: true })
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "app/a.ts" }))
})

it("keeps focus in the tab strip after closing the last tab with the keyboard", () => {
  const store = new EditorDraftStore(); open(store, ref("a.ts"))
  render(<EditorTabs roots={roots} store={store} onSave={saved(store)} />)
  const tab = screen.getByRole("tab", { name: "app/a.ts" }); tab.focus()
  fireEvent.keyDown(tab, { key: "w", ctrlKey: true })
  expect(document.activeElement).toBe(screen.getByRole("tablist"))
})

it("restores focus after a delayed save blurs the disabled confirmation button", async () => {
  const store = new EditorDraftStore(), finish = Promise.withResolvers<void>()
  open(store, ref("a.ts"), true)
  render(<EditorTabs roots={roots} store={store} onSave={async file => { await finish.promise; return saved(store)(file) }} />)
  const close = screen.getByRole("button", { name: "關閉 app/a.ts" }); close.focus(); fireEvent.click(close)
  const save = screen.getByRole("button", { name: "儲存並關閉" }) as HTMLButtonElement; save.focus(); fireEvent.click(save)
  // Chromium blurs a focused button when busy disables it. jsdom also ignores
  // blur() on a disabled button, so allow just that focus transition explicitly.
  save.disabled = false
  save.blur()
  save.disabled = true
  expect(document.activeElement).toBe(document.body)
  await act(async () => finish.resolve())
  await waitFor(() => expect(store.getSnapshot().tabs).toHaveLength(0))
  expect(document.activeElement).toBe(screen.getByRole("tablist"))
})

it("does not take focus from a surviving editor when another tab closes", () => {
  const store = new EditorDraftStore(); open(store, ref("a.ts")); open(store, ref("b.ts"))
  render(<><textarea aria-label="Editor" /><EditorTabs roots={roots} store={store} onSave={saved(store)} /></>)
  const editor = screen.getByRole("textbox"); editor.focus()
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/a.ts" }))
  expect(document.activeElement).toBe(editor)
})

it("cancels closing a dirty tab, then closes only that tab while retaining its draft", () => {
  const store = new EditorDraftStore()
  open(store, ref("clean.ts")); open(store, ref("dirty.ts"), true)
  render(<EditorTabs roots={roots} store={store} onSave={saved(store)} />)
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/dirty.ts" }))
  expect(store.getSnapshot().tabs).toHaveLength(2)
  fireEvent.click(screen.getByRole("button", { name: "取消" }))
  expect(store.getSnapshot().tabs).toHaveLength(2)
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/dirty.ts" }))
  fireEvent.click(screen.getByRole("button", { name: "保留草稿並關閉" }))
  expect(store.getSnapshot().tabs).toEqual([ref("clean.ts")])
  expect(store.get(ref("dirty.ts"))?.text).toBe("changed")
  expect(store.get(ref("clean.ts"))?.text).toBe("original")
})

it("does not close any target if edits arrive while saving even when the save succeeds", async () => {
  const store = new EditorDraftStore(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  open(store, ref("a.ts"), true); open(store, ref("clean.ts"))
  render(<EditorTabs roots={roots} store={store} onSave={async file => (await store.save(file, async () => { started.resolve(); await finish.promise; return { kind: "saved", revision: "b".repeat(64), bytes: 7 } })).kind === "saved"} />)
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/a.ts" }))
  fireEvent.click(screen.getByRole("button", { name: "儲存並關閉" }))
  await started.promise
  act(() => store.edit(ref("a.ts"), "newer edits"))
  await act(async () => finish.resolve())
  await screen.findByRole("alert")
  expect(store.getSnapshot().tabs).toHaveLength(2)
  expect(store.get(ref("a.ts"))?.text).toBe("newer edits")
  expect(isDraftDirty(store.get(ref("a.ts")))).toBe(true)
})

it("blocks saving a withdrawn file but permits draft retention", () => {
  const store = new EditorDraftStore()
  open(store, ref("a.ts"), true); open(store, ref("b.ts", "gone"), true)
  render(<EditorTabs roots={roots} store={store} onSave={saved(store)} />)
  fireEvent.click(screen.getByRole("button", { name: "關閉 已移出的資料夾/b.ts" }))
  expect((screen.getByRole("button", { name: "儲存並關閉" }) as HTMLButtonElement).disabled).toBe(true)
  expect(within(screen.getByRole("dialog")).queryByText(/gone/)).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "保留草稿並關閉" }))
  expect(store.get(ref("b.ts", "gone"))?.text).toBe("changed")
})

it("supports keyboard tab movement and saves only the file being closed", async () => {
  const store = new EditorDraftStore()
  open(store, ref("a.ts"), true); open(store, ref("b.ts"), true)
  render(<EditorTabs roots={roots} store={store} onSave={saved(store)} />)
  fireEvent.keyDown(screen.getByRole("tab", { name: "app/b.ts ●" }), { key: "ArrowLeft" })
  expect(store.getSnapshot().active).toEqual(ref("a.ts"))
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/a.ts" }))
  fireEvent.click(screen.getByRole("button", { name: "儲存並關閉" }))
  await waitFor(() => expect(store.getSnapshot().tabs).toEqual([ref("b.ts")]))
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("keeps tabs when their root is withdrawn while a save is pending", async () => {
  const store = new EditorDraftStore(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  open(store, ref("a.ts"), true)
  const onSave = async (file: ProjectFileRef) => (await store.save(file, async () => { started.resolve(); await finish.promise; return { kind: "saved", revision: "b".repeat(64), bytes: 7 } })).kind === "saved"
  const view = render(<EditorTabs roots={roots} store={store} onSave={onSave} />)
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/a.ts" }))
  fireEvent.click(screen.getByRole("button", { name: "儲存並關閉" }))
  await started.promise
  view.rerender(<EditorTabs roots={[]} store={store} onSave={onSave} />)
  await act(async () => finish.resolve())
  await screen.findByRole("alert")
  expect(store.getSnapshot().tabs).toEqual([ref("a.ts")])
})

it("does not continue closing targets after the owning pane unmounts during save", async () => {
  const store = new EditorDraftStore(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>()
  open(store, ref("a.ts"), true)
  const view = render(<EditorTabs roots={roots} store={store} onSave={async file => {
    const result = await store.save(file, async () => { started.resolve(); await finish.promise; return { kind: "saved", revision: "b".repeat(64), bytes: 7 } })
    completed.resolve(); return result.kind === "saved"
  }} />)
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/a.ts" }))
  fireEvent.click(screen.getByRole("button", { name: "儲存並關閉" }))
  await started.promise
  view.unmount()
  finish.resolve(); await completed.promise
  expect(store.getSnapshot().tabs).toEqual([ref("a.ts")])
})

it("preserves a conflicted draft and refuses save-and-close before conflict resolution", () => {
  const store = new EditorDraftStore()
  open(store, ref("a.ts"), true)
  store.ingest(ref("a.ts"), { kind: "text", text: "external", revision: "c".repeat(64), bytes: 8, truncated: false })
  render(<EditorTabs roots={roots} store={store} onSave={saved(store)} />)
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/a.ts" }))
  expect((screen.getByRole("button", { name: "儲存並關閉" }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "取消" }))
  expect(store.get(ref("a.ts"))?.text).toBe("changed")
  expect(store.get(ref("a.ts"))?.external?.text).toBe("external")
  expect(store.getSnapshot().tabs).toHaveLength(1)
})

it("selects the visible external tab and close-current leaves the underlying dirty file untouched", () => {
  const store = new EditorDraftStore(); open(store, ref("a.ts"), true)
  let closed = 0
  render(<EditorTabs roots={roots} store={store} onSave={saved(store)} externalTab={{ path: "D:/notes/reference.md", onClose: () => { closed++ } }} />)
  expect(screen.getByRole("tab", { name: "app/a.ts ●" }).getAttribute("aria-selected")).toBe("false")
  expect(screen.getByRole("tab", { name: "D:/notes/reference.md" }).getAttribute("aria-selected")).toBe("true")
  fireEvent.click(screen.getByRole("button", { name: "關閉 D:/notes/reference.md" }))
  expect(closed).toBe(1)
  expect(store.getSnapshot().tabs).toHaveLength(1)
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("closing an underlying dirty tab retains the external preview", () => {
  const store = new EditorDraftStore(); open(store, ref("a.ts"), true)
  let closed = 0
  render(<EditorTabs roots={roots} store={store} onSave={saved(store)} externalTab={{ path: "D:/notes/reference.md", onClose: () => { closed++ } }} />)
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/a.ts" }))
  fireEvent.click(screen.getByRole("button", { name: "保留草稿並關閉" }))
  expect(store.getSnapshot().tabs).toHaveLength(0)
  expect(closed).toBe(0)
  expect(screen.getByRole("tab", { name: "D:/notes/reference.md" })).toBeTruthy()
})

it("does not close a different external preview opened during the pending draft decision", () => {
  const store = new EditorDraftStore(); open(store, ref("a.ts"), true)
  let firstClosed = 0, secondClosed = 0
  const view = render(<EditorTabs roots={roots} store={store} onSave={saved(store)} externalTab={{ path: "D:/first.md", onClose: () => { firstClosed++ } }} />)
  fireEvent.click(screen.getByRole("button", { name: "關閉 app/a.ts" }))
  view.rerender(<EditorTabs roots={roots} store={store} onSave={saved(store)} externalTab={{ path: "D:/second.md", onClose: () => { secondClosed++ } }} />)
  fireEvent.click(screen.getByRole("button", { name: "捨棄草稿並關閉" }))
  expect(firstClosed).toBe(0); expect(secondClosed).toBe(0)
  expect(screen.getByRole("tab", { name: "D:/second.md" })).toBeTruthy()
})

it("closes an external-only preview and labels unresolved roots neutrally", () => {
  const store = new EditorDraftStore()
  let closed = 0
  const view = render(<EditorTabs roots={[]} store={store} onSave={saved(store)} externalTab={{ path: "D:/only.md", onClose: () => { closed++ } }} />)
  fireEvent.click(screen.getByRole("button", { name: "關閉 D:/only.md" }))
  expect(closed).toBe(1)
  act(() => open(store, ref("pending.ts", "unknown-root")))
  view.rerender(<EditorTabs roots={[]} unknownRootLabel="正在確認資料夾" store={store} onSave={saved(store)} />)
  expect(screen.getByRole("tab", { name: "正在確認資料夾/pending.ts" })).toBeTruthy()
})

it("reveals selected regular and external tabs by scrolling only the tab strip without stealing focus", () => {
  const store = new EditorDraftStore(); open(store, ref("a.ts")); open(store, ref("b.ts"))
  const view = render(<div data-testid="pane"><button type="button">Keep focus</button><EditorTabs roots={roots} store={store} onSave={saved(store)} /></div>)
  const strip = screen.getByRole("tablist"), pane = screen.getByTestId("pane")
  const bounds = (left: number, width: number) => ({ left, right: left + width, top: 100, bottom: 130, width, height: 30, x: left, y: 100, toJSON() {} })
  Object.defineProperties(strip, { clientWidth: { configurable: true, value: 200 }, clientLeft: { configurable: true, value: 1 } })
  strip.getBoundingClientRect = () => bounds(100, 202)
  screen.getByRole("tab", { name: "app/a.ts" }).parentElement!.getBoundingClientRect = () => bounds(60, 80)
  screen.getByRole("tab", { name: "app/b.ts" }).parentElement!.getBoundingClientRect = () => bounds(350, 80)
  strip.scrollLeft = 100; strip.scrollTop = 13; pane.scrollLeft = 17; pane.scrollTop = 29
  const focus = screen.getByRole("button", { name: "Keep focus" }); focus.focus()
  act(() => store.open(ref("a.ts")))
  expect(strip.scrollLeft).toBe(59)
  act(() => store.open(ref("b.ts")))
  expect(strip.scrollLeft).toBe(188)
  expect(document.activeElement).toBe(focus)
  expect([strip.scrollTop, pane.scrollLeft, pane.scrollTop]).toEqual([13, 17, 29])
  view.rerender(<div data-testid="pane"><button type="button">Keep focus</button><EditorTabs roots={roots} store={store} onSave={saved(store)} externalTab={{ path: "D:/external.md", onClose() {} }} /></div>)
  screen.getByRole("tab", { name: "D:/external.md" }).parentElement!.getBoundingClientRect = () => bounds(500, 100)
  // A width change must also bring the selected external tab back into view.
  act(() => window.dispatchEvent(new Event("resize")))
  expect(strip.scrollLeft).toBe(487)
  expect(document.activeElement).toBe(focus)
  expect([strip.scrollTop, pane.scrollLeft, pane.scrollTop]).toEqual([13, 17, 29])
})
