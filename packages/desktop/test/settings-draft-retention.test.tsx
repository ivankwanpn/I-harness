// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SettingsPane } from "../src/renderer/settings/SettingsPane.tsx"
import { ProviderDirectory } from "../src/renderer/settings/ProviderDirectory.tsx"
import { ResourceSettings } from "../src/renderer/settings/ResourceSettings.tsx"
import { HookSettings } from "../src/renderer/settings/HookSettings.tsx"
import { McpSettings } from "../src/renderer/settings/McpSettings.tsx"
import { MemoryPane } from "../src/renderer/memory/MemoryPane.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
import type { DesktopBridge, DesktopRequest } from "../src/shared/bridge.ts"

beforeEach(() => { localStorage.clear(); useLocale.getState().setLocale("zh-TW") })
afterEach(() => { cleanup(); localStorage.clear() })
const workspace = { id: "draft-a", label: "Draft A", path: "D:/I-harness-main/.tmp/draft-a" }
function bridgeFor(handle: (request: DesktopRequest) => unknown): DesktopBridge {
  return { request: vi.fn(async request => {
    if (request.kind === "desktop/local/state") return { notifications: false, notificationsSupported: true }
    if (request.kind === "desktop/terminal/options") return []
    if (request.kind === "desktop/global-preferences/state") return { enabled: false }
    return handle(request)
  }), onEvent: () => () => {} }
}
const mcpState = { servers: [{ enabled: false, revision: 7, config: { transport: "stdio", serverName: "local", command: "node", args: [] }, secretKeys: [] }] }
const providers = [
  { id: "alpha", displayName: "Alpha", configured: true, baseURL: "https://a.example", auth: { configured: true }, models: [{ id: "model", name: "Model", contextWindow: 1234, maxTokens: 200, protocol: "openai-responses", inputModalities: ["text"] }] },
  { id: "beta", displayName: "Beta", configured: true, baseURL: "https://b.example", auth: { configured: true }, models: [] },
]

it("retains an MCP form and private draft while changing settings page and hiding Settings", async () => {
  const bridge = bridgeFor(() => mcpState), capabilities = { "desktop-mcp": ["1"] }
  const view = render(<SettingsPane workspace={workspace} bridge={bridge} capabilities={capabilities} onClose={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "MCP 伺服器" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯 MCP 設定" }))
  fireEvent.change(screen.getByLabelText("執行程式"), { target: { value: "node-draft" } })
  fireEvent.click(screen.getByText("環境變數", { selector: "summary" }))
  fireEvent.change(screen.getByLabelText("私密欄位名稱"), { target: { value: "OWNED_TOKEN" } })
  fireEvent.change(screen.getByLabelText("私密欄位值"), { target: { value: "owned-secret-draft" } })
  fireEvent.click(screen.getByRole("button", { name: "加入" }))
  fireEvent.click(screen.getByRole("button", { name: "一般" }))
  fireEvent.click(screen.getByRole("button", { name: "MCP 伺服器" }))
  expect((screen.getByLabelText("執行程式") as HTMLInputElement).value).toBe("node-draft")
  view.rerender(<SettingsPane active={false} workspace={workspace} bridge={bridge} capabilities={capabilities} onClose={() => {}} />)
  expect(screen.queryByRole("textbox", { name: "執行程式" })).toBeNull()
  view.rerender(<SettingsPane workspace={workspace} bridge={bridge} capabilities={capabilities} onClose={() => {}} />)
  expect((screen.getByLabelText("執行程式") as HTMLInputElement).value).toBe("node-draft")
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/mcp/mutate", workspaceId: workspace.id, command: { action: "save", revision: 7, config: { transport: "stdio", serverName: "local", command: "node-draft", args: [] }, secrets: { env: { OWNED_TOKEN: "owned-secret-draft" } } } }))
  expect(JSON.stringify(localStorage)).not.toContain("owned-secret-draft")
})

it("retains provider editor baselines across close, provider selection and directory remount", async () => {
  const bridge = bridgeFor(() => providers)
  const view = render(<ProviderDirectory bridge={bridge} workspaceId="provider-scope" />)
  await screen.findByText("model")
  fireEvent.click(screen.getByRole("button", { name: "編輯模型" }))
  fireEvent.change(screen.getByLabelText("上下文大小"), { target: { value: "9000" } })
  fireEvent.click(screen.getByRole("button", { name: "關閉對話框" }))
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }))
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }))
  view.unmount()
  render(<ProviderDirectory bridge={bridge} workspaceId="provider-scope" />)
  await screen.findByText("model")
  fireEvent.click(screen.getByRole("button", { name: "編輯模型" }))
  expect((screen.getByLabelText("上下文大小") as HTMLInputElement).value).toBe("9000")
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/provider/mutate", workspaceId: "provider-scope", command: { action: "model/edit", id: "alpha", model: "model", fields: { contextWindow: 9000 } } }))
})

it("retains provider discovery results, selection and filter without repeating its endpoint probe", async () => {
  const bridge = bridgeFor(request => request.kind === "desktop/provider/probe" ? [{ id: "found", name: "Found model", contextWindow: 4567, protocol: "openai-responses", inputModalities: ["text", "image"] }] : providers)
  const view = render(<ProviderDirectory bridge={bridge} workspaceId="provider-scope" />)
  await screen.findByText("model")
  fireEvent.click(screen.getByRole("button", { name: "探索模型" }))
  fireEvent.change(await screen.findByRole("searchbox", { name: "篩選模型" }), { target: { value: "found" } })
  fireEvent.click(screen.getByRole("checkbox", { name: /Found model/ }))
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }))
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }))
  expect((screen.getByRole("searchbox", { name: "篩選模型" }) as HTMLInputElement).value).toBe("found")
  expect((screen.getByRole("checkbox", { name: /Found model/ }) as HTMLInputElement).checked).toBe(true)
  view.unmount()
  render(<ProviderDirectory bridge={bridge} workspaceId="provider-scope" />)
  expect((await screen.findByRole("searchbox", { name: "篩選模型" }) as HTMLInputElement).value).toBe("found")
  expect(vi.mocked(bridge.request).mock.calls.filter(([request]) => request.kind === "desktop/provider/probe")).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "加入所選模型" }))
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/provider/mutate", workspaceId: "provider-scope", command: { action: "model/add", id: "alpha", model: "found", fields: { name: "Found model", contextWindow: 4567, protocol: "openai-responses", inputModalities: ["text", "image"] } } }))
})

it("separates a new model draft from an existing model with the same editor label", async () => {
  const row = { ...providers[0], models: [{ ...providers[0].models[0], id: "new-model" }] }
  const bridge = bridgeFor(() => [row])
  render(<ProviderDirectory bridge={bridge} workspaceId="provider-scope" />)
  await screen.findByText("new-model")
  fireEvent.click(screen.getByRole("button", { name: "新增模型" }))
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "new-draft" } })
  fireEvent.change(screen.getByLabelText("上下文大小"), { target: { value: "9000" } })
  fireEvent.click(screen.getByRole("button", { name: "關閉對話框" }))
  fireEvent.click(screen.getByRole("button", { name: "編輯模型" }))
  expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("new-model")
  expect((screen.getByLabelText("上下文大小") as HTMLInputElement).value).toBe("1234")
})

it("keeps resource drafts and searches after owner remount while separating source and workspace", async () => {
  const bridge = bridgeFor(request => request.kind === "desktop/resources/list" ? { items: [{ name: "same", source: "workspace", effective: true }], total: 1, diagnostics: [] } : { name: "same", source: "workspace", body: "Original", rawBody: "Original", revision: "a".repeat(64), truncated: false })
  const author = async () => ({ kind: "conflict" })
  const view = render(<ResourceSettings bridge={bridge} workspaceId="a" resourceKind="commands" onAuthoringRequest={author} />)
  fireEvent.click(await screen.findByRole("button", { name: "same" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯本機內容" }))
  fireEvent.change(screen.getByLabelText("完整 Markdown（含 frontmatter）"), { target: { value: "Command draft A" } })
  fireEvent.click(screen.getByRole("button", { name: "關閉資源編輯器" }))
  fireEvent.change(screen.getByRole("searchbox", { name: "搜尋名稱或描述" }), { target: { value: "saved search" } })
  view.unmount()
  const other = render(<ResourceSettings bridge={bridge} workspaceId="b" resourceKind="commands" onAuthoringRequest={author} />)
  fireEvent.click(await screen.findByRole("button", { name: "same" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯本機內容" }))
  expect((screen.getByLabelText("完整 Markdown（含 frontmatter）") as HTMLTextAreaElement).value).toBe("Original")
  other.unmount()
  render(<ResourceSettings bridge={bridge} workspaceId="a" resourceKind="commands" onAuthoringRequest={author} />)
  expect((screen.getByRole("searchbox", { name: "搜尋名稱或描述" }) as HTMLInputElement).value).toBe("saved search")
  fireEvent.click(await screen.findByRole("button", { name: "same" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯本機內容" }))
  expect((screen.getByLabelText("完整 Markdown（含 frontmatter）") as HTMLTextAreaElement).value).toBe("Command draft A")
})

it("keeps a pending resource owner mounted and blocks all outer dismissal until the result", async () => {
  let finish!: (value: unknown) => void
  const pending = new Promise(done => { finish = done })
  const bridge = bridgeFor(() => ({ items: [], total: 0, diagnostics: [] }))
  const author = vi.fn(async () => pending)
  const view = render(<ResourceSettings bridge={bridge} workspaceId="a" resourceKind="commands" onAuthoringRequest={author} />)
  fireEvent.click(screen.getByRole("button", { name: "建立資源" }))
  fireEvent.change(screen.getByLabelText("名稱"), { target: { value: "owned" } })
  fireEvent.change(screen.getByLabelText("完整 Markdown（含 frontmatter）"), { target: { value: "Pending draft" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存資源" }))
  const dialog = screen.getByRole("dialog")
  expect((screen.getByRole("button", { name: "關閉資源編輯器" }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(dialog, { key: "Escape" })
  fireEvent.mouseDown(dialog.parentElement!)
  expect(screen.getByRole("dialog")).toBeTruthy()
  view.rerender(<ResourceSettings active={false} bridge={bridge} workspaceId="a" resourceKind="commands" onAuthoringRequest={author} />)
  expect(screen.queryByRole("dialog")).toBeNull()
  view.rerender(<ResourceSettings bridge={bridge} workspaceId="a" resourceKind="commands" onAuthoringRequest={author} />)
  expect((screen.getByRole("button", { name: "關閉資源編輯器" }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { finish({ kind: "conflict" }); await pending })
  expect(await screen.findByText(/來源已變更/)).toBeTruthy()
  expect((screen.getByLabelText("完整 Markdown（含 frontmatter）") as HTMLTextAreaElement).value).toBe("Pending draft")
  expect(author).toHaveBeenCalledTimes(1)
})

it("retains independent hook config and script drafts after editor owner remount", async () => {
  const bridge = bridgeFor(() => ({ handlers: [], grants: [], errors: [] }))
  const author = vi.fn(async request => ({ body: request.source === "global" ? "Global source" : "Workspace source", revision: "a".repeat(64) }))
  const view = render(<HookSettings bridge={bridge} workspaceId="a" onAuthoringRequest={author} />)
  fireEvent.click(await screen.findByRole("button", { name: "編輯本機 Hooks" }))
  fireEvent.change(await screen.findByLabelText("Hooks 設定 JSON"), { target: { value: "Workspace config draft" } })
  fireEvent.change(screen.getByLabelText("腳本名稱"), { target: { value: "owned-script" } })
  fireEvent.click(screen.getByRole("button", { name: "讀取或建立腳本" }))
  fireEvent.change(await screen.findByLabelText("Hook 腳本內容"), { target: { value: "Workspace script draft" } })
  fireEvent.change(screen.getByLabelText("保存位置"), { target: { value: "global" } })
  fireEvent.change(await screen.findByLabelText("Hooks 設定 JSON"), { target: { value: "Global config draft" } })
  view.unmount()
  render(<HookSettings bridge={bridge} workspaceId="a" onAuthoringRequest={author} />)
  fireEvent.click(await screen.findByRole("button", { name: "編輯本機 Hooks" }))
  expect((await screen.findByLabelText("保存位置") as HTMLSelectElement).value).toBe("global")
  expect((await screen.findByLabelText("Hooks 設定 JSON") as HTMLTextAreaElement).value).toBe("Global config draft")
  fireEvent.change(screen.getByLabelText("保存位置"), { target: { value: "workspace" } })
  expect((await screen.findByLabelText("Hooks 設定 JSON") as HTMLTextAreaElement).value).toBe("Workspace config draft")
  fireEvent.change(screen.getByLabelText("腳本名稱"), { target: { value: "owned-script" } })
  fireEvent.click(screen.getByRole("button", { name: "讀取或建立腳本" }))
  expect((await screen.findByLabelText("Hook 腳本內容") as HTMLTextAreaElement).value).toBe("Workspace script draft")
})

it("retains note identity and original revision when reopening a draft after the source changed", async () => {
  let revision = "a".repeat(64)
  const bridge = bridgeFor(request => request.kind === "desktop/memory/state" ? { enabled: true } : request.kind === "desktop/memory/list" ? { notes: [{ id: "note", title: "Note", revision }] } : { note: { id: "note", title: "Note", text: "Original", revision } })
  const author = vi.fn(async () => ({ kind: "conflict", note: { id: "note", title: "External", text: "Changed", revision } }))
  const view = render(<MemoryPane bridge={bridge} workspaceId="a" onAuthoringRequest={author} />)
  fireEvent.click(await screen.findByRole("button", { name: "Note" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯筆記" }))
  fireEvent.change(screen.getByLabelText("內容"), { target: { value: "Unsaved note draft" } })
  fireEvent.click(screen.getByRole("button", { name: "取消" }))
  view.unmount(); revision = "b".repeat(64)
  render(<MemoryPane bridge={bridge} workspaceId="a" onAuthoringRequest={author} />)
  fireEvent.click(await screen.findByRole("button", { name: "Note" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯筆記" }))
  expect((screen.getByLabelText("內容") as HTMLTextAreaElement).value).toBe("Unsaved note draft")
  fireEvent.click(screen.getByRole("button", { name: "儲存變更" }))
  await waitFor(() => expect(author).toHaveBeenCalledWith({ kind: "desktop/memory/update", workspaceId: "a", id: "note", title: "Note", text: "Unsaved note draft", expectedRevision: "a".repeat(64) }))
  fireEvent.click(await screen.findByRole("button", { name: "保留草稿並採用此筆記修訂" }))
  fireEvent.click(screen.getByRole("button", { name: "儲存變更" }))
  await waitFor(() => expect(author).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: "b".repeat(64), text: "Unsaved note draft" })))
})

it("keeps an MCP draft's original revision and adopts a newer source only after comparison", async () => {
  let revision = 7
  const bridge = bridgeFor(request => {
    if (request.kind === "desktop/mcp/mutate") throw new Error("Owned revision conflict")
    return { ...mcpState, servers: mcpState.servers.map(row => ({ ...row, revision })) }
  })
  const view = render(<McpSettings bridge={bridge} workspaceId="mcp-scope" />)
  fireEvent.click(await screen.findByRole("button", { name: "編輯 MCP 設定" }))
  fireEvent.change(screen.getByLabelText("執行程式"), { target: { value: "retained-node" } })
  fireEvent.click(screen.getByRole("button", { name: "取消" }))
  view.unmount(); revision = 8
  render(<McpSettings bridge={bridge} workspaceId="mcp-scope" />)
  fireEvent.click(await screen.findByRole("button", { name: "編輯 MCP 設定" }))
  expect((screen.getByLabelText("執行程式") as HTMLInputElement).value).toBe("retained-node")
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findAllByText(/Owned revision conflict/)
  expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/mcp/mutate", command: expect.objectContaining({ revision: 7 }) }))
  fireEvent.click(screen.getByRole("button", { name: "重新讀取來源以比較" }))
  fireEvent.click(await screen.findByRole("button", { name: "保留草稿並採用此來源修訂" }))
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/mcp/mutate", command: expect.objectContaining({ revision: 8, config: expect.objectContaining({ command: "retained-node" }) }) })))
})

it("restores an applied note search when its owner remounts", async () => {
  const bridge = bridgeFor(request => request.kind === "desktop/memory/state" ? { enabled: true } : request.kind === "desktop/memory/search" ? { hits: [{ id: "matched", title: "Matched note" }] } : { notes: [{ id: "all", title: "All notes fixture" }] })
  const view = render(<MemoryPane bridge={bridge} workspaceId="a" />)
  await screen.findByRole("button", { name: "All notes fixture" })
  fireEvent.change(screen.getByRole("textbox", { name: "搜尋筆記" }), { target: { value: "matched" } })
  fireEvent.click(screen.getByRole("button", { name: "搜尋" }))
  await screen.findByRole("button", { name: "Matched note" })
  view.unmount()
  render(<MemoryPane bridge={bridge} workspaceId="a" />)
  await screen.findByRole("button", { name: "Matched note" })
  expect(screen.queryByRole("button", { name: "All notes fixture" })).toBeNull()
  expect((screen.getByRole("textbox", { name: "搜尋筆記" }) as HTMLInputElement).value).toBe("matched")
})

it.each(["skills", "commands"] as const)("distinguishes initial empty %s from a search without results", async resourceKind => {
  const bridge = bridgeFor(() => ({ items: [], total: 0, diagnostics: [] }))
  render(<ResourceSettings bridge={bridge} workspaceId="a" resourceKind={resourceKind} onAuthoringRequest={async () => ({ kind: "saved" })} />)
  expect(await screen.findByText(resourceKind === "skills" ? "尚未建立技能" : "尚未建立命令")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "建立資源" }))
  expect(screen.getByRole("dialog", { name: "資源編輯器" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "關閉資源編輯器" }))
  fireEvent.change(screen.getByRole("searchbox", { name: "搜尋名稱或描述" }), { target: { value: "missing" } })
  fireEvent.click(screen.getByRole("button", { name: "搜尋" }))
  expect(await screen.findByText("沒有符合的項目")).toBeTruthy()
})
