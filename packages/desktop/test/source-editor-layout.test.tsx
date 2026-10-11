// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SourceFileEditor } from "../src/renderer/review/SourceFileEditor.tsx"
import { EditorDraftStore } from "../src/renderer/review/editor-drafts.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const ref = { workspaceId: "workspace", path: "readme.md" }
function fixture() {
  useLocale.getState().setLocale("zh-TW")
  const store = new EditorDraftStore()
  store.open(ref)
  const value = { kind: "text" as const, text: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"), truncated: false, bytes: 800, revision: "a".repeat(64) }
  store.ingest(ref, value)
  store.edit(ref, value.text + "\nunsaved")
  return { ...ref, store, value, onSave: vi.fn(async () => ({ kind: "conflict" as const })), onReload: vi.fn() }
}

it("distinguishes pending or failed root lookup from a withdrawn folder while preserving the draft", async () => {
  const props = fixture()
  const view = render(<SourceFileEditor {...props} available={false} accessPending />)
  expect(await screen.findByText("正在確認檔案存取範圍；草稿已保留。")).toBeTruthy()
  expect(screen.queryByText(/資料夾已移出/)).toBeNull()
  expect((screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement).disabled).toBe(true)
  view.rerender(<SourceFileEditor {...props} available={false} accessError="root read failed" />)
  expect(screen.getByText("無法確認檔案存取範圍；草稿已保留。")).toBeTruthy()
  view.rerender(<SourceFileEditor {...props} available={false} />)
  expect(screen.getByText(/資料夾已移出/)).toBeTruthy()
  expect(props.store.get(ref)?.text).toContain("unsaved")
  expect(props.onSave).not.toHaveBeenCalled()
})

it("fills the line-number gutter when the editor grows beyond thirty-two rows", async () => {
  let resized: ResizeObserverCallback | undefined
  const disconnect = vi.fn()
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resized = callback } observe() {} disconnect = disconnect })
  const view = render(<SourceFileEditor {...fixture()} />)
  await screen.findByRole("textbox", { name: "來源檔案內容" })
  act(() => resized?.([{ contentRect: { height: 1000 } } as ResizeObserverEntry], {} as ResizeObserver))
  expect(view.container.querySelectorAll(".source-editor-lines span").length).toBeGreaterThan(40)
  view.unmount()
  expect(disconnect).toHaveBeenCalled()
})

it("does not leave a withdrawn file with no cached draft in a permanent loading state", () => {
  render(<SourceFileEditor {...ref} store={new EditorDraftStore()} available={false} onSave={async () => ({ kind: "conflict" })} onReload={() => {}} />)
  expect(screen.getByText("此資料夾已移出目前專案。")).toBeTruthy()
  expect(screen.queryByText("正在讀取…")).toBeNull()
})
