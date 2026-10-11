// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ProjectFilesPane } from "../src/renderer/review/ProjectFilesPane.tsx"
import { EditorDraftStore } from "../src/renderer/review/editor-drafts.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
import type { ProjectFilesRequest } from "../../desktop-gateway/src/project-files.ts"
const root = { workspaceId: "uuid-must-not-appear-123456789", label: "IH workspace" }
const selection = { workspaceId: root.workspaceId }
const source = { kind: "text" as const, text: "original", revision: "a".repeat(64), bytes: 8, truncated: false }
function fixture() {
  let member = true
  const request = vi.fn(async (input: ProjectFilesRequest) => {
    if(input.kind === "desktop/project-files/roots") return { roots: member ? [root] : [] }
    if(input.kind === "desktop/project-files/list") return { entries: input.ref.path === "" ? [{ name: "src", path: "src", kind: "directory" }] : [{ name: "index.ts", path: "src/index.ts", kind: "file" }], nextOffset: null, truncated: false }
    if(input.kind === "desktop/project-files/search") return { entries: [{ name: "index.ts", path: "src/index.ts", kind: "file" }], nextOffset: null, truncated: false }
    if(input.kind === "desktop/project-files/read") return source
    if(input.kind === "desktop/project-files/external-read") return { ...source, readonly: true, external: true }
    throw new Error(`Unexpected request ${input.kind}`)
  })
  return { request, remove: () => { member = false } }
}
beforeEach(() => useLocale.getState().setLocale("zh-TW"))
afterEach(() => { cleanup(); localStorage.clear() })

it("collapses the explorer without losing the mounted search field and its results", async () => {
  const f = fixture()
  render(<ProjectFilesPane selection={selection} request={f.request} store={new EditorDraftStore()} />)
  await screen.findByRole("button", { name: "src" })
  const input = screen.getByRole("textbox", { name: "搜尋專案檔名" }) as HTMLInputElement
  fireEvent.change(input, { target: { value: "index" } })
  await screen.findByRole("button", { name: "src/index.ts" })
  fireEvent.click(screen.getByRole("button", { name: "收合檔案瀏覽器" }))
  expect(screen.queryByRole("navigation", { name: "專案檔案樹" })).toBeNull()
  expect(input.isConnected).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "展開檔案瀏覽器", expanded: false }))
  expect(screen.getByRole("textbox", { name: "搜尋專案檔名" })).toBe(input)
  expect(input.value).toBe("index")
  expect(screen.getByRole("button", { name: "src/index.ts" })).toBeTruthy()
})

it.each(["pending", "failed"] as const)("uses a neutral folder label while membership is %s", async status => {
  const store = new EditorDraftStore(), ref = { workspaceId: root.workspaceId, path: "src/index.ts" }
  store.open(ref); store.ingest(ref, source)
  const request = async () => status === "pending" ? new Promise(() => {}) : Promise.reject(new Error("root lookup failed"))
  const { container } = render(<ProjectFilesPane selection={selection} request={request} store={store} />)
  if (status === "failed") await screen.findByText("root lookup failed")
  expect(container.querySelector(".project-file-breadcrumb")?.textContent).toBe("資料夾/src/index.ts")
  expect(container.textContent).not.toContain("已移出的資料夾")
  expect(container.textContent).not.toContain(root.workspaceId)
})

it("closes the external preview and normal tabs individually without deleting retained drafts", async () => {
  const f = fixture(), store = new EditorDraftStore(), ref = { workspaceId: root.workspaceId, path: "src/index.ts" }
  store.open(ref); store.ingest(ref, source); store.edit(ref, "keep this draft")
  render(<ProjectFilesPane selection={selection} request={f.request} store={store} externalOpenFile={{ reference: { path: "D:/reference/readme.md", readonly: true } }} />)
  await screen.findByRole("region", { name: "唯讀參考檔案" })
  fireEvent.click(screen.getByRole("button", { name: "關閉 D:/reference/readme.md" }))
  fireEvent.click(screen.getByRole("button", { name: "關閉 IH workspace/src/index.ts" }))
  fireEvent.click(screen.getByRole("button", { name: "保留草稿並關閉" }))
  await waitFor(() => expect(screen.queryByRole("region", { name: "唯讀參考檔案" })).toBeNull())
  expect(store.getSnapshot().tabs).toHaveLength(0)
  expect(store.get(ref)?.text).toBe("keep this draft")
})

it("highlights the selected tree file and shows a human breadcrumb", async () => {
  const f = fixture()
  const { container } = render(<ProjectFilesPane selection={selection} request={f.request} store={new EditorDraftStore()} />)
  fireEvent.click(await screen.findByRole("button", { name: "src" }))
  fireEvent.click(await screen.findByRole("button", { name: "index.ts" }))
  await screen.findByRole("textbox", { name: "來源檔案內容" })
  expect(screen.getByRole("button", { name: "index.ts" }).getAttribute("aria-current")).toBe("true")
  expect(container.querySelector(".project-file-breadcrumb")?.textContent).toBe("IH workspace/src/index.ts")
  expect(container.querySelector(".project-files-editor-region")).toBeTruthy()
})

it("retains withdrawn-root drafts and a cached human breadcrumb without exposing the workspace id", async () => {
  const f = fixture(), store = new EditorDraftStore(), ref = { workspaceId: root.workspaceId, path: "src/index.ts" }
  const { container } = render(<ProjectFilesPane selection={selection} request={f.request} store={store} openFile={ref} />)
  const editor = await screen.findByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement
  await waitFor(() => expect(editor.value).toBe("original"))
  fireEvent.change(editor, { target: { value: "retained draft" } })
  f.remove()
  fireEvent.click(screen.getByRole("button", { name: "重新整理專案檔案" }))
  await waitFor(() => expect(editor.disabled).toBe(true))
  expect(store.get(ref)?.text).toBe("retained draft")
  expect(container.querySelector(".project-file-breadcrumb")?.textContent).toContain("IH workspace")
  expect(container.querySelector(".project-file-breadcrumb")?.textContent).not.toContain(root.workspaceId)
  expect(await screen.findByText("資料夾已移出目前專案；草稿已保留，無法讀取或儲存。")).toBeTruthy()
})
