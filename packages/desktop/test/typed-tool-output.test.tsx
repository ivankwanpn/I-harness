// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { ToolActivity } from "../src/renderer/session/ToolActivity.tsx"

afterEach(cleanup)
const diff = { path: "src/owned.ts", added: 1, deleted: 1, truncated: true, hunks: [{ oldStart: 7, oldLines: 1, newStart: 7, newLines: 1, lines: [{ kind: "delete", text: "old", oldLine: 7 }, { kind: "add", text: "new", newLine: 7, noNewline: true }] }] }

it("shows actual shell omission counts on each stream while copying the complete captured text", async () => {
  const writes: string[] = []
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  render(<ToolActivity name="bash" output={{ stdout: "captured stdout", stderr: "captured stderr", exitCode: 0, truncated: { stdoutBytes: 900, stderrBytes: 700 } }} expanded />)
  expect(within(screen.getByRole("region", { name: "stdout" })).getByText("記錄的輸出已截斷")).toBeTruthy()
  expect(within(screen.getByRole("region", { name: "stderr" })).getByText("記錄的輸出已截斷")).toBeTruthy()
  expect(screen.getByText("stdout 省略 900 bytes")).toBeTruthy()
  expect(screen.getByText("stderr 省略 700 bytes")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "複製 stdout" }))
  await waitFor(() => expect(writes).toEqual(["captured stdout"]))
})

it("shows upstream truncation with an unknown omitted size instead of claiming zero loss", () => {
  render(<ToolActivity name="pwsh" output={{ stdout: "upstream tail", stderr: "", exitCode: 0, truncated: { stdoutBytes: 0, stderrBytes: 0 } }} expanded />)
  expect(screen.getByText("記錄的輸出已截斷；未回報完整省略數量。")).toBeTruthy()
  expect(screen.queryByText(/省略 0 bytes/)).toBeNull()
})

it.each([{ stdout: true, stderr: false }, true])("retains legacy truncation indicators %j", truncated => {
  render(<ToolActivity name="shell" output={{ stdout: "bounded capture", stderr: "", exitCode: 0, truncated }} expanded />)
  expect(within(screen.getByRole("region", { name: "stdout" })).getByText("記錄的輸出已截斷")).toBeTruthy()
})

it("reads command stdout and stderr before arguments and preserves exit and signal evidence", () => {
  const view = render(<ToolActivity name="pwsh" args={{ command: "node owned-fixture.mjs", cwd: "D:/owned" }} output={{ stdout: "partial output", stderr: "actual failure", exitCode: 12, signal: "SIGTERM", customReceipt: { id: "retained-receipt" } }} expanded />)
  expect(screen.getByText("node owned-fixture.mjs")).toBeTruthy()
  expect(within(screen.getByRole("region", { name: "stdout" })).getByText("partial output")).toBeTruthy()
  expect(within(screen.getByRole("region", { name: "stderr" })).getByText("actual failure")).toBeTruthy()
  expect(screen.getByText("結束代碼 12")).toBeTruthy()
  expect(screen.getByText("Signal SIGTERM")).toBeTruthy()
  expect(view.container.querySelector("details")!.open).toBe(false)
  expect(screen.queryByText(/retained-receipt/)).toBeNull()
  fireEvent.click(screen.getByText("原始記錄"))
  expect(screen.getByText(/retained-receipt/)).toBeTruthy()
})

it("distinguishes dispatch from an actual running Code Mode observation", () => {
  const view = render(<ToolActivity name="bash" args={{ command: "node fixture" }} dispatched />)
  expect(screen.getByText("已派發，等待結果")).toBeTruthy()
  expect(screen.queryByText("執行中")).toBeNull()
  view.rerender(<ToolActivity name="code_exec" args={{ code: "text(await tools.read({path:'owned.txt'}))" }} output={{ cellId: "cell-a", status: "running", text: "new captured text", truncated: false }} expanded />)
  expect(screen.getByText("執行中")).toBeTruthy()
  expect(screen.getByText("new captured text")).toBeTruthy()
  expect(screen.getByText("cell-a")).toBeTruthy()
})

it("uses explicit stopped and failed records without manufacturing an error reason", () => {
  const view = render(<ToolActivity name="grep" output={{ status: "cancelled", partial: true, truncated: false, matches: [], reasons: ["aborted"] }} expanded />)
  expect(screen.getByText("已取消")).toBeTruthy()
  expect(screen.getByText("部分結果")).toBeTruthy()
  expect(screen.getByText("aborted")).toBeTruthy()
  expect(screen.queryByText("沒有符合的內容。")).toBeNull()
  view.rerender(<ToolActivity name="plugin_noop" resultReceived isError expanded />)
  expect(screen.getByText("執行失敗")).toBeTruthy()
  expect(screen.getByText("未記錄輸出內容")).toBeTruthy()
  expect(screen.queryByText(/取消/)).toBeNull()
})

it.each(["change", "changes", "applied"])("renders the actual recorded %s TextDiff once with its truncation and newline marker", key => {
  const output = key === "change" ? { ok: true, change: diff, applied: [{ path: diff.path, action: "update", change: diff }] }
    : key === "changes" ? { ok: true, changes: [diff], applied: [{ path: diff.path, action: "update", change: diff }] }
      : { ok: true, applied: [{ path: diff.path, action: "update", change: diff }, { path: "new.txt", action: "add" }], rawPatch: "*** Begin Patch\n*** Add File: new.txt\n+created\n*** End Patch" }
  const view = render(<ToolActivity name="apply_patch" args={{ patch_content: "original invocation" }} output={output} expanded />)
  expect(view.container.querySelectorAll("[data-lightweight-diff-preview]")).toHaveLength(1)
  expect(screen.getByText("-old")).toBeTruthy()
  expect(screen.getByText("+new")).toBeTruthy()
  expect(screen.getByText("\\ No newline at end of file")).toBeTruthy()
  expect(screen.getByText("記錄的差異已截斷")).toBeTruthy()
  if (key === "applied") {
    expect(screen.getByRole("region", { name: "原始 Patch 語法" })).toBeTruthy()
    expect(screen.getByText(/\*\*\* Add File: new.txt/)).toBeTruthy()
  }
})

it("never invents a file diff when only write success was recorded", () => {
  const view = render(<ToolActivity name="write" args={{ path: "new.txt", text: "input draft" }} output={{ ok: true, isNewFile: true }} expanded />)
  expect(screen.getByText("這次操作未記錄檔案差異")).toBeTruthy()
  expect(view.container.querySelector("[data-lightweight-diff-preview]")).toBeNull()
  expect(screen.queryByText(/\+input draft/)).toBeNull()
})

it("opens a captured search location with the owning root and revision", () => {
  const targets: unknown[] = []
  render(<ToolActivity name="grep" args={{ pattern: "needle", path: "D:/second" }} output={{ matches: [{ path: "D:/second/a.ts", line: 9, column: 2, endLine: 9, endColumn: 8, text: "needle", revision: "captured-r1", encoding: "utf8" }], status: "limited", partial: true, truncated: true, reasons: ["max-results"] }} expanded navigation={{ workspaceId: "first", workspacePath: "D:/first", projectRoots: [{ workspaceId: "first", path: "D:/first" }, { workspaceId: "second", path: "D:/second" }], onOpenFile: () => { throw new Error("lost owning root") }, onOpenProjectFile: target => { targets.push(target) } }} />)
  fireEvent.click(screen.getByRole("button", { name: "在成果面板開啟 a.ts:9" }))
  expect(targets).toHaveLength(1)
  expect(targets[0]).toMatchObject({ workspaceId: "second", path: "a.ts", navigation: { line: 9, column: 2, endLine: 9, endColumn: 8, revision: "captured-r1", encoding: "utf8" } })
  expect(screen.getByText("部分結果")).toBeTruthy()
  expect(screen.getByText("結果已截斷")).toBeTruthy()
})

it("renders MCP captured text and web sources safely with unknown data accessible", () => {
  const view = render(<ToolActivity name="mcp__owned__lookup" output={[{ type: "text", text: "<script>captured, never executed</script>" }, { type: "custom", opaque: "kept evidence" }]} expanded />)
  expect(screen.getByText("<script>captured, never executed</script>")).toBeTruthy()
  expect(view.container.querySelector("script")).toBeNull()
  fireEvent.click(screen.getByText("原始記錄"))
  expect(screen.getByText(/kept evidence/)).toBeTruthy()
  view.rerender(<ToolActivity name="websearch" args={{ query: "owned query" }} output={{ content: "search response", sources: [{ title: "Source", url: "https://example.test/owned", snippet: "Captured snippet" }, { title: "Unsafe reference", url: "javascript:alert(1)" }], truncated: true }} expanded />)
  expect(screen.getByRole("link", { name: "Source" }).getAttribute("href")).toBe("https://example.test/owned")
  expect(screen.queryByRole("link", { name: "Unsafe reference" })).toBeNull()
  expect(screen.getByText("Unsafe reference")).toBeTruthy()
})

it("shows persisted retained-result identity and completeness without inventing a read capability", () => {
  render(<ToolActivity name="read" output={{ content: "bounded recorded text" }} resultRefs={[{ id: "r1", workspaceId: "owned", sessionId: "s1", callId: "c1", label: "owned.txt", revision: "rev1", bytes: 12, originalBytes: 120, complete: false, expiresAt: 10, source: { sourceId: "source1", path: "owned.txt", readonly: true } }]} expanded />)
  fireEvent.click(screen.getByText("owned.txt"))
  expect(screen.getByText("r1")).toBeTruthy()
  expect(screen.getByText("rev1")).toBeTruthy()
  expect(screen.getByText("部分保留 · 12 / 120 bytes")).toBeTruthy()
  expect(screen.queryByRole("button", { name: /完整結果|重新執行/ })).toBeNull()
})

it("reads deferred tool definitions and Code Context hits with their actual source identity", () => {
  const targets: unknown[] = []
  const view = render(<ToolActivity name="tool_search" args={{ query: "owned lookup" }} output={{ query: "owned lookup", totalDeferred: 5, matches: [{ name: "mcp__owned__lookup", description: "Look up the owned fixture", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] }} expanded />)
  expect(screen.getByText("owned lookup")).toBeTruthy()
  expect(screen.getByRole("region", { name: "搜尋結果" }).querySelector("code")?.textContent).toBe("mcp__owned__lookup\nLook up the owned fixture")
  expect(screen.queryByText(/inputSchema/)).toBeNull()
  view.rerender(<ToolActivity name="code_context_search" args={{ query: "owned symbol" }} output={{ hits: [{ sourceId: "reference-a", path: "same.ts", revision: "reference-rev", generation: 2, text: "reference hit", startLine: 4, endLine: 7, startOffset: 22, endOffset: 45, score: 1.2 }], mode: "lexical", partial: true, reasons: ["max-files"], generation: 2 }} expanded navigation={{ workspacePath: "D:/owned", workspaceId: "owned", projectRoots: [{ workspaceId: "owned", path: "D:/owned" }], onOpenFile: target => { targets.push(target) }, onOpenProjectFile: target => { targets.push(target) } }} />)
  expect(screen.getByRole("region", { name: "搜尋結果" }).querySelector("code")?.textContent).toBe("reference-a · same.ts:4\nreference hit")
  expect(screen.queryByRole("button", { name: /在成果面板開啟 same.ts/ })).toBeNull()
  expect(targets).toEqual([])
})

it("copies the actual unified diff and wraps it without changing recorded line numbers", async () => {
  const writes: string[] = []
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  const view = render(<ToolActivity name="edit" output={{ ok: true, change: diff }} expanded />)
  fireEvent.click(screen.getByRole("button", { name: "複製差異 src/owned.ts" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "已複製差異 src/owned.ts" })).toBeTruthy())
  expect(writes).toEqual(["--- a/src/owned.ts\n+++ b/src/owned.ts\n@@ -7,1 +7,1 @@\n-old\n+new\n\\ No newline at end of file\n"])
  fireEvent.click(screen.getByRole("button", { name: "自動換行差異 src/owned.ts" }))
  expect(view.container.querySelector(".tool-recorded-diff")!.getAttribute("data-wrap")).toBe("true")
  expect(screen.getByText("-old").previousElementSibling?.textContent).toBe("7")
})

it("previews captured images and keeps their complete raw bytes copyable", async () => {
  const previews: unknown[] = [], writes: string[] = []
  const image = { mediaType: "image/png", dataBase64: "aGVsbG8=", name: "owned.png" }
  const output = { images: [image], additionalCapture: { opaque: "retained" } }
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  render(<ToolActivity name="read_image" output={output} expanded onPreview={preview => { previews.push(preview) }} />)
  expect(screen.queryByText(/aGVsbG8=/)).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "owned.png" }))
  expect(previews).toEqual([{ name: "owned.png", src: "data:image/png;base64,aGVsbG8=" }])
  fireEvent.click(screen.getByText("原始記錄"))
  fireEvent.click(screen.getByRole("button", { name: "複製 原始輸出" }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(JSON.parse(writes[0]!)).toEqual(output)
})
