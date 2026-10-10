// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SourceFileEditor } from "../src/renderer/review/SourceFileEditor.tsx"
import { ProjectFilesPane } from "../src/renderer/review/ProjectFilesPane.tsx"
import { EditorDraftStore } from "../src/renderer/review/editor-drafts.ts"
import { projectFilesFixture } from "./project-files-fixture.ts"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProjectFilesRequest } from "../../desktop-gateway/src/project-files.ts"

const fixtures: Awaited<ReturnType<typeof projectFilesFixture>>[] = []
afterEach(async () => { cleanup(); localStorage.clear(); for (const f of fixtures.splice(0)) { await f.dispose(); await rm(f.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } })
const contents = () => screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement

it("revalidates a saved file on keep-and-reopen without ingesting its obsolete cached preview", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const store = new EditorDraftStore()
  render(<ProjectFilesPane selection={f.selection} request={f.request} store={store} />)
  fireEvent.click(await screen.findByTitle("first/same.txt"))
  await waitFor(() => expect(contents().value).toBe("first"))
  fireEvent.change(contents(), { target: { value: "saved first" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存檔案" }))
  await screen.findByText("檔案已儲存")
  expect(await readFile(join(f.first.path, "same.txt"), "utf8")).toBe("saved first")
  fireEvent.change(contents(), { target: { value: "newer unsaved draft" } })
  fireEvent.click(screen.getByRole("button", { name: "關閉 first/same.txt" }))
  fireEvent.click(screen.getByRole("button", { name: "保留草稿並關閉" }))
  fireEvent.click(screen.getByTitle("first/same.txt"))
  await waitFor(() => expect((screen.getByRole("button", { name: "儲存檔案" }) as HTMLButtonElement).disabled).toBe(false))
  expect(contents().value).toBe("newer unsaved draft")
  expect(screen.queryByText("檢視外部版本")).toBeNull()
  expect(await readFile(join(f.first.path, "same.txt"), "utf8")).toBe("saved first")
  await writeFile(join(f.first.path, "same.txt"), "actual external change")
  fireEvent.click(screen.getByRole("button", { name: "重新整理專案檔案" }))
  await screen.findByText("檢視外部版本")
  expect((screen.getByRole("button", { name: "儲存檔案" }) as HTMLButtonElement).disabled).toBe(true)
  expect(contents().value).toBe("newer unsaved draft")
  expect(store.get({ workspaceId: f.first.id, path: "same.txt" })?.external?.text).toBe("actual external change")
})

it("restores the second root draft after editor unmount without replacing the first root", async () => {
  const source = (text: string) => ({ kind: "text" as const, text, revision: "a".repeat(64), bytes: text.length, truncated: false })
  const saved: string[] = []
  const save = async (_path: string, text: string) => { saved.push(text); return { kind: "saved" as const, revision: "b".repeat(64), bytes: text.length } }
  const view = render(<SourceFileEditor workspaceId="second" path="same.txt" value={source("second")} onSave={save} onReload={() => {}} />)
  fireEvent.change(screen.getByRole("textbox", { name: "來源檔案內容" }), { target: { value: "edited second" } })
  view.rerender(<SourceFileEditor workspaceId="first" path="same.txt" value={source("first")} onSave={save} onReload={() => {}} />)
  expect((screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement).value).toBe("first")
  view.unmount()
  render(<SourceFileEditor workspaceId="second" path="same.txt" value={source("second")} onSave={save} onReload={() => {}} />)
  expect((screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement).value).toBe("edited second")
  fireEvent.click(screen.getByRole("button", { name: "儲存檔案" }))
  await waitFor(() => expect(saved).toEqual(["edited second"]))
})

it("opens both real roots, keeps a closed draft across panel/restart, and saves only the second file", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const storage = new Map<string, string>(), persistence = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
  const store = new EditorDraftStore(persistence)
  const view = render(<ProjectFilesPane selection={f.selection} request={f.request} store={store} />)
  await waitFor(() => expect(screen.getAllByRole("button", { name: "same.txt" })).toHaveLength(2))
  fireEvent.click(screen.getAllByRole("button", { name: "same.txt" })[0]!)
  await waitFor(() => expect(contents().value).toBe("first"))
  fireEvent.click(screen.getAllByRole("button", { name: "same.txt" })[1]!)
  await waitFor(() => expect(contents().value).toBe("second"))
  expect(screen.getByRole("tab", { name: "first/same.txt" })).toBeTruthy()
  expect(screen.getByRole("tab", { name: "second/same.txt" })).toBeTruthy()
  fireEvent.change(contents(), { target: { value: "edited second" } })
  fireEvent.click(screen.getByRole("tab", { name: "first/same.txt" }))
  await waitFor(() => expect(contents().value).toBe("first"))
  fireEvent.click(screen.getByRole("tab", { name: "second/same.txt ●" }))
  await waitFor(() => expect(contents().value).toBe("edited second"))
  fireEvent.click(screen.getByRole("button", { name: "關閉 second/same.txt" }))
  fireEvent.click(screen.getByRole("button", { name: "保留草稿並關閉" }))
  expect(screen.queryByRole("tab", { name: "second/same.txt ●" })).toBeNull()
  fireEvent.click(screen.getAllByRole("button", { name: "same.txt" })[1]!)
  await waitFor(() => expect(contents().value).toBe("edited second"))
  view.unmount()
  const restarted = new EditorDraftStore(persistence)
  render(<ProjectFilesPane selection={f.selection} request={f.request} store={restarted} />)
  await waitFor(() => expect((screen.getByRole("button", { name: "儲存檔案" }) as HTMLButtonElement).disabled).toBe(false))
  expect(contents().value).toBe("edited second")
  fireEvent.click(screen.getByRole("button", { name: "儲存檔案" }))
  await waitFor(() => expect(screen.getByText("檔案已儲存")).toBeTruthy())
  expect(await readFile(join(f.first.path, "same.txt"), "utf8")).toBe("first")
  expect(await readFile(join(f.second.path, "same.txt"), "utf8")).toBe("edited second")
})

it("dirty close offers save/keep/discard; failed CAS save retains the tab and external reload retains edits", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const store = new EditorDraftStore(), ref = { workspaceId: f.second.id, path: "same.txt" }
  render(<ProjectFilesPane selection={f.selection} request={f.request} store={store} openFile={ref} />)
  await waitFor(() => expect(contents().value).toBe("second"))
  fireEvent.change(contents(), { target: { value: "my changes" } })
  await writeFile(join(f.second.path, "same.txt"), "external")
  fireEvent.click(screen.getByRole("button", { name: "關閉 second/same.txt" }))
  expect(screen.getByRole("button", { name: "保留草稿並關閉" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "捨棄草稿並關閉" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "儲存並關閉" }))
  await waitFor(() => expect(screen.getByText("未能儲存；分頁和草稿已保留。")).toBeTruthy())
  expect(screen.getByRole("tab", { name: "second/same.txt ●" })).toBeTruthy()
  expect(contents().value).toBe("my changes")
  expect(await readFile(join(f.second.path, "same.txt"), "utf8")).toBe("external")
  fireEvent.click(screen.getByRole("button", { name: "取消" }))
  fireEvent.click(screen.getByRole("button", { name: "捨棄編輯並重新讀取" }))
  fireEvent.click(screen.getByRole("button", { name: "保留草稿並讀取外部版本" }))
  await waitFor(() => expect(screen.getByText("檢視外部版本")).toBeTruthy())
  expect(contents().value).toBe("my changes")
  await waitFor(() => expect((screen.getByRole("button", { name: "捨棄草稿並採用外部版本" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "捨棄草稿並採用外部版本" }))
  expect(contents().value).toBe("external")
  fireEvent.change(contents(), { target: { value: "discard me" } })
  fireEvent.click(screen.getByRole("button", { name: "關閉 second/same.txt" }))
  fireEvent.click(screen.getByRole("button", { name: "捨棄草稿並關閉" }))
  expect(store.get(ref)).toBeUndefined()
  expect(await readFile(join(f.second.path, "same.txt"), "utf8")).toBe("external")
})

it("saves successfully when closing a dirty tab", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  render(<ProjectFilesPane selection={f.selection} request={f.request} store={new EditorDraftStore()} openFile={{ workspaceId: f.second.id, path: "same.txt" }} />)
  await waitFor(() => expect(contents().value).toBe("second"))
  fireEvent.change(contents(), { target: { value: "saved on close" } })
  fireEvent.click(screen.getByRole("button", { name: "關閉 second/same.txt" }))
  fireEvent.click(screen.getByRole("button", { name: "儲存並關閉" }))
  await waitFor(() => expect(screen.queryByRole("tab", { name: "second/same.txt ●" })).toBeNull())
  expect(await readFile(join(f.second.path, "same.txt"), "utf8")).toBe("saved on close")
})

it("does not accept a stale read after switching to another root", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  let release: (() => void) | undefined, delayed = false
  const request = async (input: ProjectFilesRequest) => {
    const result = await f.request(input)
    if (input.kind === "desktop/project-files/read" && input.ref.workspaceId === f.second.id) {
      delayed = true
      await new Promise<void>((resolve) => { release = resolve })
    }
    return result
  }
  const store = new EditorDraftStore()
  const view = render(<ProjectFilesPane selection={f.selection} request={request} store={store} openFile={{ workspaceId: f.second.id, path: "same.txt" }} />)
  await waitFor(() => expect(delayed).toBe(true))
  view.rerender(<ProjectFilesPane selection={f.selection} request={request} store={store} openFile={{ workspaceId: f.first.id, path: "same.txt" }} />)
  await waitFor(() => expect(contents().value).toBe("first"))
  release!()
  await waitFor(() => expect(contents().value).toBe("first"))
  expect(store.get({ workspaceId: f.second.id, path: "same.txt" })).toBeUndefined()
})

it("keeps withdrawn-root edits while disabling source access and save", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  const store = new EditorDraftStore(), ref = { workspaceId: f.second.id, path: "same.txt" }
  render(<ProjectFilesPane selection={f.selection} request={f.request} store={store} openFile={ref} />)
  await waitFor(() => expect(contents().value).toBe("second"))
  fireEvent.change(contents(), { target: { value: "keep withdrawn" } })
  await f.projects.save({ id: f.project.id, name: "Only first", workspaceIds: [f.first.id] })
  fireEvent.click(screen.getByRole("button", { name: "重新整理專案檔案" }))
  await waitFor(() => expect(contents().disabled).toBe(true))
  expect((screen.getByRole("button", { name: "儲存檔案" }) as HTMLButtonElement).disabled).toBe(true)
  expect(store.get(ref)?.text).toBe("keep withdrawn")
  expect(await readFile(join(f.second.path, "same.txt"), "utf8")).toBe("second")
})

it("ignores an old filename page when the search query changes", async () => {
  const f = await projectFilesFixture(); fixtures.push(f)
  await f.seedFiles(f.second.id, Array.from({ length: 101 }, (_, n) => `page-${String(n).padStart(4, "0")}.txt`))
  const rootsReady = Promise.withResolvers<void>(), initialPages = Promise.withResolvers<void>(), currentPages = Promise.withResolvers<void>(), heldPageReady = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const completed = new Map<string, Set<string>>()
  let heldResponse: Promise<unknown> | undefined
  const request = async (input: ProjectFilesRequest) => {
    const result = await f.request(input)
    if (input.kind === "desktop/project-files/roots") rootsReady.resolve()
    if (input.kind === "desktop/project-files/search" && input.offset === 0) {
      const roots = completed.get(input.query) ?? new Set<string>(); roots.add(input.ref.workspaceId); completed.set(input.query, roots)
      if (roots.size === 2) (input.query === "page-" ? initialPages : currentPages).resolve()
    }
    if (input.kind === "desktop/project-files/search" && input.query === "page-" && input.offset === 100) { heldPageReady.resolve(); await release.promise }
    return result
  }
  try {
    render(<ProjectFilesPane selection={f.selection} request={input => { const response = request(input); if (input.kind === "desktop/project-files/search" && input.query === "page-" && input.offset === 100) heldResponse = response; return response }} store={new EditorDraftStore()} />)
    await act(async () => { await rootsReady.promise })
    await waitFor(() => expect(screen.getByRole("button", { name: "▾ second" })).toBeTruthy())
    fireEvent.change(screen.getByRole("textbox", { name: "搜尋專案檔名" }), { target: { value: "page-" } })
    await act(async () => { await initialPages.promise })
    await waitFor(() => expect(screen.getByRole("button", { name: "載入更多搜尋結果" })).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "載入更多搜尋結果" }))
    await act(async () => { await heldPageReady.promise })
    fireEvent.change(screen.getByRole("textbox", { name: "搜尋專案檔名" }), { target: { value: "same" } })
    await act(async () => { await currentPages.promise })
    await waitFor(() => expect(screen.getAllByRole("button", { name: "same.txt" })).toHaveLength(2))
    await act(async () => { release.resolve(); await heldResponse })
    expect(screen.queryByRole("button", { name: "page-0100.txt" })).toBeNull()
  } finally { release.resolve(); await heldResponse }
})
