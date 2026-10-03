// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { ProjectExplorer } from "../src/renderer/review/ProjectExplorer.tsx"
import { ProjectFilesPane } from "../src/renderer/review/ProjectFilesPane.tsx"
import { EditorDraftStore } from "../src/renderer/review/editor-drafts.ts"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProjectFilesRequest } from "../../desktop-gateway/src/project-files.ts"

const selection = { workspaceId: "host", sessionId: "owner", projectId: "project" }
const roots = [{ workspaceId: "first", label: "First" }, { workspaceId: "second", label: "Second" }]
type FilesFixture = Awaited<ReturnType<typeof import("./project-files-fixture.ts").projectFilesFixture>>
const fixtures: FilesFixture[] = []
const projectFilesFixture = async () => (await import("./project-files-fixture.ts")).projectFilesFixture()
afterEach(async () => { cleanup(); localStorage.clear(); for (const fixture of fixtures.splice(0)) { await fixture.dispose(); await rm(fixture.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } })
const emptyPage = { entries: [], nextOffset: null, truncated: false }
function result(matches: Record<string, unknown>[] = [], extra: Record<string, unknown> = {}) {
  return { matches, roots, status: "completed", partial: false, truncated: false, reasons: [], diagnostics: [],
    stats: { candidateFiles: 2, attemptedFiles: 2, readFiles: 2, completedFiles: 2, eofFiles: 2, inputBytes: 80, engineRawBytes: 120, runnerRawBytes: 0 },
    filters: { hidden: false, respectIgnore: true, ignorePolicy: "project-local", exclusions: [".git", "node_modules"] }, limits: { maxResults: 250, maxResultBytes: 262144, timeoutMs: 30000 }, ...extra }
}
const match = (workspaceId: string, text = "needle", line = 2) => ({ ref: { workspaceId, path: "same.txt" }, path: "same.txt", line, text, column: 0, endLine: line, endColumn: text.length, encoding: "utf8", revision: "a".repeat(64) })
function openContent() { fireEvent.click(screen.getByRole("button", { name: "檔案內容" })) }
function submit(pattern: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "搜尋專案檔案內容" }), { target: { value: pattern } })
  fireEvent.submit(screen.getByRole("form", { name: "搜尋檔案內容" }))
}
type Input = ProjectFilesRequest & Record<string, unknown>

describe("project content search lifecycle", () => {
  it("submits one aggregate query explicitly and exposes its effective project filters", async () => {
    const calls: Input[] = []
    const request = async (input: ProjectFilesRequest) => { calls.push(input as Input); return input.kind === "desktop/project-files/content-search" ? result([match("second")]) : emptyPage }
    render(<ProjectExplorer roots={roots} selection={selection} request={request} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    openContent()
    fireEvent.change(screen.getByRole("textbox", { name: "搜尋專案檔案內容" }), { target: { value: "needle" } })
    expect(calls.filter(input => input.kind === "desktop/project-files/content-search")).toHaveLength(0)
    fireEvent.submit(screen.getByRole("form", { name: "搜尋檔案內容" }))
    await screen.findByRole("button", { name: "Second/same.txt:2" })
    const searches = calls.filter(input => input.kind === "desktop/project-files/content-search")
    expect(searches).toHaveLength(1)
    expect(searches[0]).toMatchObject({ ...selection, workspaceIds: ["first", "second"], query: { pattern: "needle", mode: "literal", case: "sensitive", respectIgnore: true, maxResults: 250, maxResultBytes: 262144, timeoutMs: 30000 } })
    expect(typeof searches[0]?.requestId).toBe("string")
    expect(screen.getByLabelText("搜尋結果摘要").textContent).toContain("套用專案忽略檔")
  })

  it("Stop sends the original owner and request ID to a separate cancellation RPC", async () => {
    const held = Promise.withResolvers<unknown>(), calls: Input[] = []
    const request = async (input: ProjectFilesRequest) => { calls.push(input as Input); if (input.kind === "desktop/project-files/content-search") return held.promise; if (input.kind === "desktop/project-files/content-cancel") return { cancelled: true }; return emptyPage }
    render(<ProjectExplorer roots={roots} selection={selection} request={request} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    openContent(); submit("needle")
    expect(screen.getByRole("status").textContent).toContain("搜尋中")
    fireEvent.click(screen.getByRole("button", { name: "停止搜尋" }))
    await waitFor(() => expect(calls.filter(input => input.kind === "desktop/project-files/content-cancel")).toHaveLength(1))
    expect(calls.find(input => input.kind === "desktop/project-files/content-cancel")).toEqual({ ...selection, kind: "desktop/project-files/content-cancel", requestId: calls.find(input => input.kind === "desktop/project-files/content-search")?.requestId })
    await act(async () => { held.resolve(result([], { status: "cancelled", partial: true, reasons: ["cancelled"] })); await held.promise })
    expect(screen.getByLabelText("搜尋結果摘要").textContent).toContain("已取消")
    expect(screen.queryByText("沒有符合的內容。")).toBeNull()
  })

  it("cancels a replaced query and withholds its obsolete reply", async () => {
    const old = Promise.withResolvers<unknown>(), calls: Input[] = []
    const request = async (input: ProjectFilesRequest) => { calls.push(input as Input); if (input.kind === "desktop/project-files/content-search") return input.query.pattern === "old" ? old.promise : result([match("second", "current")]); if (input.kind === "desktop/project-files/content-cancel") return { cancelled: true }; return emptyPage }
    render(<ProjectExplorer roots={roots} selection={selection} request={request} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    openContent(); submit("old"); submit("new")
    await screen.findByText("current")
    expect(calls.filter(input => input.kind === "desktop/project-files/content-cancel")).toHaveLength(1)
    await act(async () => { old.resolve(result([match("first", "obsolete")])); await old.promise })
    expect(screen.queryByText("obsolete")).toBeNull()
    expect(screen.getByText("current")).toBeTruthy()
  })

  it("retains the original cancellation owner across root withdrawal, selection changes and unmount", async () => {
    const held = Promise.withResolvers<unknown>(), calls: Input[] = []
    const request = async (input: ProjectFilesRequest) => { calls.push(input as Input); if (input.kind === "desktop/project-files/content-search") return held.promise; if (input.kind === "desktop/project-files/content-cancel") return { cancelled: true }; return emptyPage }
    const view = render(<ProjectExplorer roots={roots} selection={selection} request={request} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    openContent(); submit("needle")
    view.rerender(<ProjectExplorer roots={[roots[0]!]} selection={{ workspaceId: "new-host", projectId: "new-project" }} request={request} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    await waitFor(() => expect(calls.filter(input => input.kind === "desktop/project-files/content-cancel")).toHaveLength(1))
    expect(calls.find(input => input.kind === "desktop/project-files/content-cancel")).toMatchObject(selection)
    view.unmount()
    await act(async () => { held.resolve(result([match("second", "withdrawn")])); await held.promise })
    expect(calls.filter(input => input.kind === "desktop/project-files/content-cancel")).toHaveLength(1)
  })

  it("cancels an outstanding search when the pane unmounts or its request fails", async () => {
    const held = Promise.withResolvers<unknown>(), calls: Input[] = []
    const request = async (input: ProjectFilesRequest) => { calls.push(input as Input); if (input.kind === "desktop/project-files/content-search") return held.promise; if (input.kind === "desktop/project-files/content-cancel") return { cancelled: true }; return emptyPage }
    const view = render(<ProjectExplorer roots={roots} selection={selection} request={request} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    openContent(); submit("needle"); view.unmount()
    await waitFor(() => expect(calls.filter(input => input.kind === "desktop/project-files/content-cancel")).toHaveLength(1))
    await act(async () => { held.reject(new Error("transport closed")); await held.promise.catch(() => {}) })
    expect(calls.filter(input => input.kind === "desktop/project-files/content-cancel")).toHaveLength(1)
    calls.length = 0
    render(<ProjectExplorer roots={roots} selection={selection} request={async input => { calls.push(input as Input); if (input.kind === "desktop/project-files/content-search") throw new Error("transport timeout"); if (input.kind === "desktop/project-files/content-cancel") return { cancelled: true }; return emptyPage }} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    openContent(); submit("needle")
    await screen.findByRole("alert")
    expect(calls.filter(input => input.kind === "desktop/project-files/content-cancel")).toHaveLength(1)
  })

  it("shows partial limits and diagnostics without claiming an incomplete empty search has no matches", async () => {
    render(<ProjectExplorer roots={roots} selection={selection} request={async input => input.kind === "desktop/project-files/content-search" ? result([], { status: "limited", partial: true, truncated: true, reasons: ["input-bytes"], diagnostics: ["Second: ignore policy incomplete"] }) : emptyPage} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    openContent(); submit("needle")
    await waitFor(() => expect(screen.getByLabelText("搜尋結果摘要").textContent).toContain("已達上限"))
    expect(screen.getByText("input-bytes")).toBeTruthy()
    expect(screen.getByText("Second: ignore policy incomplete")).toBeTruthy()
    expect(screen.queryByText("沒有符合的內容。")).toBeNull()
  })

  it("validates raw results before any row can navigate and disables an unavailable capability", async () => {
    const view = render(<ProjectExplorer roots={roots} selection={selection} request={async input => input.kind === "desktop/project-files/content-search" ? result([{ ...match("second"), ref: { workspaceId: "second", path: "../outside" }, line: 0 }]) : emptyPage} refresh={0} contentSearchAvailable onOpen={() => { throw new Error("Malformed hit acquired navigation") }} />)
    openContent(); submit("needle")
    await screen.findByRole("alert")
    expect(screen.queryByRole("button", { name: "Second/same.txt:0" })).toBeNull()
    view.rerender(<ProjectExplorer roots={roots} selection={selection} request={async () => emptyPage} refresh={0} contentSearchAvailable={false} onOpen={() => {}} />)
    expect((screen.getByRole("button", { name: "搜尋內容" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("目前後端未提供專案內容搜尋。")).toBeTruthy()
  })

  it("passes advanced filters as bounded options and pages only its returned snapshot", async () => {
    const calls: Input[] = []
    const matches = Array.from({ length: 30 }, (_, index) => ({ ...match("second", `line ${index}`, index + 1), path: `file-${index}.txt`, ref: { workspaceId: "second", path: `file-${index}.txt` } }))
    render(<ProjectExplorer roots={roots} selection={selection} request={async input => { calls.push(input as Input); return input.kind === "desktop/project-files/content-search" ? result(matches) : emptyPage }} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    openContent()
    fireEvent.click(screen.getByText("進階搜尋選項"))
    fireEvent.change(screen.getByRole("textbox", { name: "包含路徑" }), { target: { value: "src/**\n*.txt" } })
    fireEvent.change(screen.getByRole("textbox", { name: "排除路徑" }), { target: { value: "build/**" } })
    fireEvent.change(screen.getByRole("spinbutton", { name: "前文行數" }), { target: { value: "2" } })
    fireEvent.change(screen.getByRole("spinbutton", { name: "後文行數" }), { target: { value: "3" } })
    fireEvent.click(screen.getByRole("checkbox", { name: "包含隱藏檔案" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "專案忽略檔" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "跨行搜尋" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "正規表示式" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "區分大小寫" }))
    fireEvent.change(screen.getByRole("combobox", { name: "正規表示式引擎" }), { target: { value: "pcre2" } })
    fireEvent.change(screen.getByRole("combobox", { name: "內容編碼" }), { target: { value: "utf16le" } })
    submit("needle")
    await screen.findByRole("button", { name: "Second/file-0.txt:1" })
    expect(calls.find(input => input.kind === "desktop/project-files/content-search")?.query).toMatchObject({ mode: "regex", case: "insensitive", before: 2, after: 3, includes: ["src/**", "*.txt"], excludes: ["build/**"], hidden: true, respectIgnore: false, multiline: true, regexEngine: "pcre2", encoding: "utf16le" })
    fireEvent.click(screen.getByRole("button", { name: "下一頁搜尋結果" }))
    expect(screen.getByRole("button", { name: "Second/file-25.txt:26" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Second/file-0.txt:1" })).toBeNull()
    expect(calls.filter(input => input.kind === "desktop/project-files/content-search")).toHaveLength(1)
  })

  it("retains valid error matches and reports unknown effective filters honestly", async () => {
    render(<ProjectExplorer roots={roots} selection={selection} request={async input => input.kind === "desktop/project-files/content-search" ? result([match("second")], { status: "error", partial: true, error: "Unreadable policy file", filters: {} }) : emptyPage} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    openContent(); submit("needle")
    await screen.findByRole("button", { name: "Second/same.txt:2" })
    expect(screen.getByRole("alert").textContent).toContain("Unreadable policy file")
    expect(screen.getByLabelText("搜尋結果摘要").textContent).toContain("未回報完整篩選設定")
    expect(screen.getByLabelText("搜尋結果摘要").textContent).not.toContain("套用專案忽略檔")
  })

  it("refuses a combined include and exclude policy beyond the shared query bound", async () => {
    const calls: Input[] = []
    render(<ProjectExplorer roots={roots} selection={selection} request={async input => { calls.push(input as Input); return emptyPage }} refresh={0} contentSearchAvailable onOpen={() => {}} />)
    openContent(); fireEvent.click(screen.getByText("進階搜尋選項"))
    const eightGlobs = Array.from({ length: 8 }, () => "a".repeat(300)).join("\n")
    fireEvent.change(screen.getByRole("textbox", { name: "包含路徑" }), { target: { value: eightGlobs } })
    fireEvent.change(screen.getByRole("textbox", { name: "排除路徑" }), { target: { value: eightGlobs } })
    submit("needle")
    await screen.findByRole("alert")
    expect(calls.filter(input => input.kind === "desktop/project-files/content-search")).toHaveLength(0)
  })
})

describe("search hit file ownership and preview", () => {
  it("searches and opens an actual external reference file while leaving its bytes and editor state untouched", async () => {
    const fixture = await projectFilesFixture(); fixtures.push(fixture)
    const folder = join(fixture.home, "reference"), absolute = join(folder, "outside.txt"), calls: Input[] = []
    await mkdir(folder)
    await writeFile(absolute, "before\n中😀 needle\nafter")
    const store = new EditorDraftStore()
    render(<ProjectFilesPane selection={fixture.selection} store={store} contentSearchAvailable request={input => { calls.push(input as Input); return fixture.request(input) }} />)
    await screen.findByRole("button", { name: "▾ second" })
    openContent(); fireEvent.click(screen.getByText("進階搜尋選項"))
    fireEvent.change(screen.getByRole("textbox", { name: "參考位置（唯讀）" }), { target: { value: absolute } })
    submit("needle")
    fireEvent.click(await screen.findByRole("button", { name: /outside\.txt:2$/ }))
    const preview = await screen.findByRole("region", { name: "唯讀搜尋預覽" })
    expect(within(preview).getByText("needle", { selector: "mark" })).toBeTruthy()
    expect(preview.textContent).toContain("專案外檔案僅供唯讀。")
    expect(store.getSnapshot()).toMatchObject({ tabs: [], drafts: {} })
    expect(screen.queryByRole("button", { name: "儲存檔案" })).toBeNull()
    expect(calls.filter(input => input.kind === "desktop/project-files/save")).toEqual([])
    expect(await readFile(absolute, "utf8")).toBe("before\n中😀 needle\nafter")
  })
  it("searches a pasted absolute reference location without creating a project root, draft or save flow", async () => {
    const store = new EditorDraftStore(), calls: Input[] = [], absolute = "D:/reference/outside.txt"
    render(<ProjectFilesPane selection={selection} request={async input => {
      calls.push(input as Input)
      if (input.kind === "desktop/project-files/roots") return { roots }
      if (input.kind === "desktop/project-files/content-search") return result([{ ...match("second"), ref: undefined, path: "outside.txt", reference: { path: absolute, readonly: true }, readonly: true, external: true }], { roots: [] })
      if (input.kind === "desktop/project-files/external-preview") return { readonly: true, external: true, text: "before\nneedle\nafter", startLine: 1, encoding: "utf8", revision: "a".repeat(64), changedSinceSearch: false, truncated: false }
      if (input.kind === "desktop/project-files/read" || input.kind === "desktop/project-files/save") throw new Error("Reference file entered project write flow")
      return emptyPage
    }} store={store} contentSearchAvailable />)
    await screen.findByRole("button", { name: "▾ Second" })
    openContent(); fireEvent.click(screen.getByText("進階搜尋選項"))
    fireEvent.change(screen.getByRole("textbox", { name: "參考位置（唯讀）" }), { target: { value: absolute } })
    submit("needle")
    fireEvent.click(await screen.findByRole("button", { name: `${absolute}:2` }))
    const preview = await screen.findByRole("region", { name: "唯讀搜尋預覽" })
    expect(within(preview).getByText("needle", { selector: "mark" })).toBeTruthy()
    expect(calls.find(input => input.kind === "desktop/project-files/content-search")).toMatchObject({ referencePath: absolute })
    expect(calls.find(input => input.kind === "desktop/project-files/content-search")).not.toHaveProperty("workspaceIds")
    expect(calls.find(input => input.kind === "desktop/project-files/external-preview")).toMatchObject({ ...selection, path: absolute, line: 2, encoding: "utf8", expectedRevision: "a".repeat(64) })
    expect(store.getSnapshot()).toMatchObject({ drafts: {}, tabs: [] })
    expect(screen.queryByRole("button", { name: "儲存檔案" })).toBeNull()
    expect(calls.filter(input => input.kind === "desktop/project-files/roots")).toHaveLength(1)
  })

  it("opens a file-only external target transiently and restores an existing project draft from its tab", async () => {
    const store = new EditorDraftStore(), ref = { workspaceId: "second", path: "same.txt" }, absolute = "D:/reference/file.txt", calls: Input[] = []
    const source = { kind: "text" as const, text: "project disk", bytes: 12, truncated: false, revision: "a".repeat(64) }
    store.open(ref); store.ingest(ref, source); store.edit(ref, "my project draft")
    render(<ProjectFilesPane selection={selection} store={store} externalOpenFile={{ reference: { path: absolute, readonly: true } }} request={async input => {
      calls.push(input as Input)
      if (input.kind === "desktop/project-files/roots") return { roots }
      if (input.kind === "desktop/project-files/read") return source
      if (input.kind === "desktop/project-files/external-read") return { ...source, text: "external file text", readonly: true, external: true }
      if (input.kind === "desktop/project-files/save") throw new Error("External viewer must not save")
      return emptyPage
    }} />)
    const preview = await screen.findByRole("region", { name: "唯讀檔案預覽" })
    expect(preview.textContent).toContain("external file text")
    expect(screen.queryByRole("textbox", { name: "來源檔案內容" })).toBeNull()
    expect(calls.find(input => input.kind === "desktop/project-files/external-read")).toEqual({ ...selection, kind: "desktop/project-files/external-read", path: absolute, requestId: expect.any(String) })
    fireEvent.click(screen.getByRole("tab", { name: "Second/same.txt ●" }))
    await waitFor(() => expect((screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement).value).toBe("my project draft"))
    expect(store.getSnapshot().tabs).toEqual([ref])
    expect(store.get(ref)?.revision).toBe("a".repeat(64))
  })
  it("treats external UTF8 search matches as read-only without invoking editable read or save", async () => {
    const store = new EditorDraftStore(), calls: Input[] = []
    render(<ProjectFilesPane selection={selection} request={async input => {
      calls.push(input as Input)
      if (input.kind === "desktop/project-files/roots") return { roots }
      if (input.kind === "desktop/project-files/content-search") return result([{ ...match("second"), readonly: true, external: true }])
      if (input.kind === "desktop/project-files/search-preview") return { readonly: true, external: true, text: "before\nneedle\nafter", startLine: 1, encoding: "utf8", revision: "a".repeat(64), changedSinceSearch: false, truncated: false }
      if (input.kind === "desktop/project-files/read" || input.kind === "desktop/project-files/save") throw new Error("External search hit entered editable file flow")
      return emptyPage
    }} store={store} contentSearchAvailable />)
    await screen.findByRole("button", { name: "▾ Second" })
    openContent(); submit("needle"); fireEvent.click(await screen.findByRole("button", { name: "Second/same.txt:2" }))
    const preview = await screen.findByRole("region", { name: "唯讀搜尋預覽" })
    expect(preview.textContent).toContain("專案外檔案僅供唯讀。")
    expect(screen.queryByRole("button", { name: "儲存檔案" })).toBeNull()
    expect(store.get({ workspaceId: "second", path: "same.txt" })).toBeUndefined()
    expect(calls.filter(input => input.kind === "desktop/project-files/read" || input.kind === "desktop/project-files/save")).toEqual([])
  })
  it("opens the actual second root range, repeats the same hit and retains its unsaved draft", async () => {
    const fixture = await projectFilesFixture(); fixtures.push(fixture)
    await writeFile(join(fixture.first.path, "same.txt"), "first\r\nneedle\r\nlast")
    await writeFile(join(fixture.second.path, "same.txt"), "\uFEFFtop\r\n中😀 needle \t\r\nlast")
    const store = new EditorDraftStore()
    render(<ProjectFilesPane selection={fixture.selection} request={fixture.request} store={store} contentSearchAvailable />)
    await screen.findByRole("button", { name: "▾ second" })
    openContent(); submit("needle")
    fireEvent.click(await screen.findByRole("button", { name: "second/same.txt:2" }))
    await waitFor(() => expect((screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement).selectionStart).toBe(8))
    const editor = screen.getByRole("textbox", { name: "來源檔案內容" }) as HTMLTextAreaElement
    expect(editor.selectionEnd).toBe(14)
    expect(editor.value).toBe("top\n中😀 needle \t\nlast")
    expect(store.get({ workspaceId: fixture.first.id, path: "same.txt" })).toBeUndefined()
    fireEvent.change(editor, { target: { value: `${editor.value}\nlocal changes` } })
    editor.setSelectionRange(0, 0)
    fireEvent.click(screen.getByRole("button", { name: "second/same.txt:2" }))
    await waitFor(() => expect(editor.selectionStart).toBe(8))
    expect(editor.value.endsWith("local changes")).toBe(true)
    expect(screen.getByText("搜尋位置來自磁碟；未儲存草稿的位置可能不同。")).toBeTruthy()
    expect(store.getSnapshot().tabs).toEqual([{ workspaceId: fixture.second.id, path: "same.txt" }])
  })

  it("opens UTF16 search text as a bounded read-only window with original line numbers and no draft ingestion", async () => {
    const store = new EditorDraftStore(), calls: Input[] = []
    const preview = { readonly: true, text: "before\n中😀 needle\nafter", startLine: 40, encoding: "utf16le", revision: "b".repeat(64), changedSinceSearch: true, truncated: true, reason: "windowed-preview" }
    render(<ProjectFilesPane selection={selection} request={async input => { calls.push(input as Input); if (input.kind === "desktop/project-files/roots") return { roots }; if (input.kind === "desktop/project-files/content-search") return result([{ ...match("second", "中😀 needle", 41), column: 4, endColumn: 10, encoding: "utf16le" }]); if (input.kind === "desktop/project-files/search-preview") return preview; if (input.kind === "desktop/project-files/read") throw new Error("UTF16 hit entered UTF8 draft reader"); return emptyPage }} store={store} contentSearchAvailable />)
    await screen.findByRole("button", { name: "▾ Second" })
    openContent(); submit("needle"); fireEvent.click(await screen.findByRole("button", { name: "Second/same.txt:41" }))
    const pane = await screen.findByRole("region", { name: "唯讀搜尋預覽" })
    expect(within(pane).getByText("41")).toBeTruthy()
    expect(within(pane).getByText("needle", { selector: "mark" })).toBeTruthy()
    expect(within(pane).getByText("檔案已在搜尋後變更；標示位置可能不同。")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "儲存檔案" })).toBeNull()
    expect(store.get({ workspaceId: "second", path: "same.txt" })).toBeUndefined()
    expect(calls.find(input => input.kind === "desktop/project-files/search-preview")).toMatchObject({ ...selection, ref: { workspaceId: "second", path: "same.txt" }, line: 41, encoding: "utf16le", expectedRevision: "a".repeat(64) })
  })
})
