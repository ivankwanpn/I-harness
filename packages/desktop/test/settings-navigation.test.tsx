// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SettingsPane } from "../src/renderer/settings/SettingsPane.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
import { usePreferences } from "../src/renderer/design/preferences.ts"
import type { DesktopBridge, DesktopRequest } from "../src/shared/bridge.ts"

const workspace = { id: "settings-fixture", label: "Settings fixture", path: "D:/I-harness-main/.tmp/settings-navigation" }
const capabilities = { "desktop-resources": ["1"], "desktop-resource-authoring": ["1"] }
beforeEach(() => { localStorage.clear(); useLocale.getState().setLocale("zh-TW") })
afterEach(() => { cleanup(); localStorage.clear(); usePreferences.getState().reset(); useLocale.getState().setLocale("zh-TW") })

function bridgeFor(handle: (request: DesktopRequest) => unknown = () => undefined): DesktopBridge {
  return { request: vi.fn(async request => {
    if (request.kind === "desktop/local/state") return { notifications: false, notificationsSupported: true }
    if (request.kind === "desktop/terminal/options") return []
    if (request.kind === "desktop/global-preferences/state") return { enabled: false }
    return handle(request)
  }), onEvent: () => () => {} }
}

function resourceBridge() {
  return bridgeFor(request => {
    if (request.kind === "desktop/resources/list") return { items: [{ name: request.resourceKind === "skills" ? "local-skill" : "local-command", source: "workspace", effective: true }], total: 1, diagnostics: [] }
    if (request.kind === "desktop/resources/read") return { name: request.name, source: "workspace", body: "Original", rawBody: "Original", revision: "a".repeat(64), truncated: false, effective: true }
    if (request.kind === "desktop/resources/write") return { kind: "conflict", currentRevision: "b".repeat(64) }
    return undefined
  })
}

it("opens local language, theme and font preferences together in General", () => {
  render(<SettingsPane onClose={() => {}} />)
  expect(screen.getByRole("combobox", { name: "語言" })).toBeTruthy()
  expect(screen.getByRole("combobox", { name: "外觀" })).toBeTruthy()
  expect(screen.getByRole("combobox", { name: "文字大小" })).toBeTruthy()
  const navigation = within(screen.getByRole("navigation", { name: "設定分類" }))
  expect(navigation.queryByRole("button", { name: "外觀" })).toBeNull()
  expect(navigation.queryByRole("button", { name: "工作區" })).toBeNull()
  expect(screen.queryByRole("checkbox", { name: "顯示側欄" })).toBeNull()
  expect(screen.queryByRole("checkbox", { name: "成果檢查" })).toBeNull()
})

it("migrates the old Appearance section to General without changing saved preferences", () => {
  localStorage.setItem("ih:settings-section", "appearance")
  usePreferences.getState().update({ appearance: "light", fontSize: 18 })
  render(<SettingsPane onClose={() => {}} />)
  expect(screen.getByRole("heading", { name: "一般", level: 1 })).toBeTruthy()
  expect((screen.getByRole("combobox", { name: "外觀" }) as HTMLSelectElement).value).toBe("light")
  expect((screen.getByRole("combobox", { name: "文字大小" }) as HTMLSelectElement).value).toBe("18")
  expect(localStorage.getItem("ih:settings-section")).toBe("general")
})

it("resets appearance without changing saved pane sizes or sidebar visibility", () => {
  localStorage.setItem("ih:settings-section", "appearance")
  usePreferences.getState().update({ appearance: "light", fontSize: 18, sidebarCollapsed: true, sidebarWidth: 310, reviewWidth: 460 })
  render(<SettingsPane onClose={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "重設外觀偏好" }))
  expect(usePreferences.getState()).toMatchObject({ appearance: "dark", fontSize: 14, sidebarCollapsed: true, sidebarWidth: 310, reviewWidth: 460 })
})

it("keeps Agent Shell available in execution settings when it is independently advertised", async () => {
  const bridge = bridgeFor(request => request.kind === "desktop/agent-shell/state" ? { selected: "auto", options: [{ id: "auto", label: "Auto" }, { id: "pwsh", label: "PowerShell" }], executionTarget: "native" } : undefined)
  render(<SettingsPane workspace={workspace} bridge={bridge} capabilities={{ "desktop-agent-shell": ["1"] }} onClose={() => {}} />)
  expect(bridge.request).not.toHaveBeenCalledWith({ kind: "desktop/agent-shell/state", workspaceId: workspace.id })
  fireEvent.click(screen.getByRole("button", { name: "執行與權限" }))
  await screen.findByRole("combobox", { name: "Agent Shell" })
  expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/agent-shell/state", workspaceId: workspace.id })
  expect(bridge.request).not.toHaveBeenCalledWith({ kind: "desktop/agent-settings/state", workspaceId: workspace.id })
})

it.each(["skills", "commands"] as const)("migrates the old %s section to its named resource tab", async kind => {
  localStorage.setItem("ih:settings-section", kind)
  localStorage.setItem("ih:settings-resource-kind", kind === "skills" ? "commands" : "skills")
  const bridge = resourceBridge()
  render(<SettingsPane workspace={workspace} bridge={bridge} capabilities={capabilities} onClose={() => {}} />)
  expect(screen.getByRole("heading", { name: "資源", level: 1 })).toBeTruthy()
  expect(screen.getByRole("tab", { name: kind === "skills" ? "技能" : "命令" }).getAttribute("aria-selected")).toBe("true")
  await screen.findByRole("button", { name: kind === "skills" ? "local-skill" : "local-command" })
  expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/resources/list", workspaceId: workspace.id, resourceKind: kind, query: "", offset: 0, includeShadowed: true })
  expect(localStorage.getItem("ih:settings-section")).toBe("resources")
  expect(localStorage.getItem("ih:settings-resource-kind")).toBe(kind)
})

it.each([
  ["WSL", "執行與權限"], ["sandbox", "執行與權限"], ["approval", "執行與權限"],
  ["embedding", "執行與權限"], ["context-mode", "執行與權限"], ["claude-context", "執行與權限"], ["API key", "模型與提供商"], ["終端字體", "一般"],
  ["shell", "執行與權限"], ["技能", "資源"], ["commands", "資源"],
])("finds %s through field and function aliases", (query, destination) => {
  render(<SettingsPane onClose={() => {}} />)
  fireEvent.change(screen.getByRole("searchbox", { name: "搜尋設定" }), { target: { value: query } })
  const navigation = within(screen.getByRole("navigation", { name: "設定分類" }))
  expect(navigation.getByRole("button", { name: destination })).toBeTruthy()
  expect(navigation.queryByRole("button", { name: "關於" })).toBeNull()
})

it("opens the matching command tab from search and keeps localized search useful in English", async () => {
  useLocale.getState().setLocale("en")
  const bridge = resourceBridge()
  render(<SettingsPane workspace={workspace} bridge={bridge} capabilities={capabilities} onClose={() => {}} />)
  fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "commands" } })
  fireEvent.click(screen.getByRole("button", { name: "Resources" }))
  expect(screen.getByRole("tab", { name: "Commands" }).getAttribute("aria-selected")).toBe("true")
  await screen.findByRole("button", { name: "local-command" })
  fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "文字大小" } })
  expect(screen.getByRole("button", { name: "General" })).toBeTruthy()
})

it.each([
  ["Text size", "General"], ["Interface language", "General"], ["Follow-up message delivery", "General"],
  ["Integrated terminal shell", "General"], ["Enable Code Context", "Execution and permissions"],
  ["Automatic conversation titles", "General"], ["Open conversation", "Notifications"],
])("finds the visible English field label %s", (query, destination) => {
  useLocale.getState().setLocale("en")
  render(<SettingsPane onClose={() => {}} />)
  fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: query } })
  expect(screen.getByRole("button", { name: destination })).toBeTruthy()
})

it.each(["context-subsystems", "context-mode", "claude-context"])("routes the former %s destination to execution", alias => {
  localStorage.setItem("ih:settings-section", alias)
  render(<SettingsPane onClose={() => {}} />)
  expect(screen.getByRole("heading", { name: "執行與權限", level: 1 })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "上下文與檢索" })).toBeNull()
  expect(localStorage.getItem("ih:settings-section")).toBe("execution")
})

it("shows a recoverable empty search without losing the selected page", () => {
  render(<SettingsPane onClose={() => {}} />)
  fireEvent.change(screen.getByRole("searchbox", { name: "搜尋設定" }), { target: { value: "does-not-exist" } })
  expect(screen.getByRole("status").textContent).toContain("沒有符合的設定")
  expect(screen.getByRole("heading", { name: "一般", level: 1 })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "清除搜尋" }))
  expect(screen.getByRole("button", { name: "資源" })).toBeTruthy()
})

it("keeps capability explanations on the selected page and leaves navigation operable", async () => {
  const bridge = bridgeFor()
  const view = render(<SettingsPane workspace={workspace} bridge={bridge} onClose={() => {}} />)
  const execution = screen.getByRole("button", { name: "執行與權限" })
  expect(execution.hasAttribute("aria-disabled")).toBe(false)
  expect(screen.getByRole("navigation", { name: "設定分類" }).querySelectorAll("small")).toHaveLength(0)
  fireEvent.click(execution)
  expect(screen.getByRole("status").textContent).toBe("正在讀取工作區功能…")
  expect(bridge.request).not.toHaveBeenCalledWith({ kind: "desktop/agent-settings/state", workspaceId: workspace.id })
  view.rerender(<SettingsPane bridge={bridge} onClose={() => {}} />)
  expect(screen.getByRole("status").textContent).toBe("請先選擇工作區以使用此設定。")
  view.rerender(<SettingsPane workspace={workspace} bridge={bridge} capabilities={{ "desktop-memory": ["1"] }} onClose={() => {}} />)
  expect(screen.getByRole("status").textContent).toBe("目前工作區後端未提供此功能。")
})

it("loads resource tabs on first visit and keeps independent editor drafts across navigation", async () => {
  const bridge = resourceBridge()
  render(<SettingsPane workspace={workspace} bridge={bridge} capabilities={capabilities} onClose={() => {}} />)
  expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/resources/list" }))
  fireEvent.click(screen.getByRole("button", { name: "資源" }))
  await screen.findByRole("button", { name: "local-skill" })
  expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/resources/list", resourceKind: "commands" }))
  fireEvent.click(screen.getByRole("button", { name: "local-skill" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯本機內容" }))
  fireEvent.change(screen.getByLabelText("完整 Markdown（含 frontmatter）"), { target: { value: "Skill draft" } })
  fireEvent.click(screen.getByRole("button", { name: "關閉資源編輯器" }))
  fireEvent.click(screen.getByRole("tab", { name: "命令" }))
  await screen.findByRole("button", { name: "local-command" })
  fireEvent.click(screen.getByRole("button", { name: "建立資源" }))
  fireEvent.change(screen.getByLabelText("完整 Markdown（含 frontmatter）"), { target: { value: "Command draft" } })
  fireEvent.click(screen.getByRole("button", { name: "關閉資源編輯器" }))
  fireEvent.click(screen.getByRole("button", { name: "一般" }))
  fireEvent.click(screen.getByRole("button", { name: "資源" }))
  expect(screen.getByRole("tab", { name: "命令" }).getAttribute("aria-selected")).toBe("true")
  fireEvent.click(screen.getByRole("button", { name: "建立資源" }))
  expect((screen.getByLabelText("完整 Markdown（含 frontmatter）") as HTMLTextAreaElement).value).toBe("Command draft")
  fireEvent.click(screen.getByRole("button", { name: "關閉資源編輯器" }))
  fireEvent.click(screen.getByRole("tab", { name: "技能" }))
  fireEvent.click(screen.getByRole("button", { name: "local-skill" }))
  fireEvent.click(await screen.findByRole("button", { name: "編輯本機內容" }))
  expect((screen.getByLabelText("完整 Markdown（含 frontmatter）") as HTMLTextAreaElement).value).toBe("Skill draft")
  expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/resources/write" }))
  expect(vi.mocked(bridge.request).mock.calls.filter(([request]) => request.kind === "desktop/resources/list")).toHaveLength(2)
})

it("links resource tab controls to named panels and supports keyboard selection", async () => {
  localStorage.setItem("ih:settings-section", "skills")
  render(<SettingsPane workspace={workspace} bridge={resourceBridge()} capabilities={capabilities} onClose={() => {}} />)
  const skills = screen.getByRole("tab", { name: "技能" })
  skills.focus()
  fireEvent.keyDown(skills, { key: "ArrowRight" })
  const commands = screen.getByRole("tab", { name: "命令" })
  expect(document.activeElement).toBe(commands)
  expect(commands.getAttribute("aria-selected")).toBe("true")
  const panel = screen.getByRole("tabpanel", { name: "命令" })
  expect(commands.getAttribute("aria-controls")).toBe(panel.id)
  expect(panel.getAttribute("aria-labelledby")).toBe(commands.id)
  expect(localStorage.getItem("ih:settings-resource-kind")).toBe("commands")
  await screen.findByRole("button", { name: "local-command" })
  fireEvent.keyDown(commands, { key: "Home" })
  expect(document.activeElement).toBe(skills)
  expect(skills.getAttribute("aria-selected")).toBe("true")
})

it("waits for a resource visit before loading resources in a newly selected workspace", async () => {
  const bridge = resourceBridge()
  const view = render(<SettingsPane workspace={workspace} bridge={bridge} capabilities={capabilities} onClose={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "資源" }))
  await screen.findByRole("button", { name: "local-skill" })
  fireEvent.click(screen.getByRole("button", { name: "一般" }))
  const other = { ...workspace, id: "other-owned-workspace" }
  view.rerender(<SettingsPane workspace={other} bridge={bridge} capabilities={capabilities} onClose={() => {}} />)
  expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/resources/list", workspaceId: other.id }))
  fireEvent.click(screen.getByRole("button", { name: "資源" }))
  await screen.findByRole("button", { name: "local-skill" })
  expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/resources/list", workspaceId: other.id }))
})
