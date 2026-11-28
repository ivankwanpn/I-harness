// @vitest-environment jsdom
import { useState } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { DESKTOP_CONFIGURATION_ID } from "@i-harness/desktop-gateway/src/host-protocol.ts"
import { ExtensionsSettings, type ExtensionTab } from "../src/renderer/settings/ExtensionsSettings.tsx"
import type { DesktopRequest } from "../src/shared/bridge.ts"

afterEach(cleanup)
it("retains an unchanged catalogue and reloads it after enabling a plugin in another tab", async () => {
  let enabled = false
  const request = vi.fn(async (input: DesktopRequest) => {
    if (input.kind === "desktop/plugins/state") return { sources: [], plugins: [{ id: "p", name: "Plugin", installed: true, enabled }] }
    if (input.kind === "desktop/plugins/mutate" && input.command.action === "enable") { enabled = true; return { ok: true } }
    if (input.kind === "desktop/resources/list") return { items: enabled ? [{ name: "added", source: "plugin", pluginId: "p" }] : [], total: Number(enabled), diagnostics: [] }
    throw Error(input.kind)
  })
  const bridge = { request, onEvent: () => () => {} }
  function Subject() {
    const [tab, onSelect] = useState<ExtensionTab>("skills")
    return <ExtensionsSettings bridge={bridge} tab={tab} onSelect={onSelect} />
  }
  render(<Subject />)
  await screen.findByText("尚未建立技能")
  fireEvent.click(screen.getByRole("tab", { name: "插件" }))
  await screen.findByRole("button", { name: "啟用" })
  fireEvent.click(screen.getByRole("tab", { name: "技能" }))
  expect(screen.getByText("尚未建立技能")).toBeTruthy()
  fireEvent.click(screen.getByRole("tab", { name: "插件" }))
  fireEvent.click(await screen.findByRole("button", { name: "啟用" }))
  await screen.findByRole("button", { name: "停用" })
  expect(request.mock.calls.filter(([input]) => input.kind === "desktop/resources/list")).toHaveLength(1)
  fireEvent.click(screen.getByRole("tab", { name: "技能" }))
  await screen.findByRole("button", { name: "added" })
  expect(request.mock.calls.filter(([input]) => input.kind === "desktop/resources/list")).toHaveLength(2)
})

it("leaves unsupported tabs readable without asking an older workspace gateway for an unavailable route", async () => {
  const request = vi.fn(async () => { throw Error("unexpected request") })
  render(<ExtensionsSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="old-folder" capabilities={{}}
    tab="plugins" onSelect={() => {}} />)
  await screen.findByText("此工作區的 Gateway 不支援插件。")
  expect(request).not.toHaveBeenCalled()
})

it("opens shared settings on demand, authors only global resources and switches to a folder without reusing its profile draft", async () => {
  const request = vi.fn(async (input: DesktopRequest) => {
    if (input.kind === "desktop/resources/list") return { items: [], total: 0, diagnostics: [] }
    if (input.kind === "desktop/plugins/state") return { sources: [], plugins: [] }
    if (input.kind === "desktop/mcp/state") return { servers: [] }
    throw Error(input.kind)
  })
  const bridge = { request, onEvent: () => () => {} }
  function Subject({ workspaceId }: { workspaceId?: string }) {
    const [tab, select] = useState<ExtensionTab>("mcp")
    return <ExtensionsSettings bridge={bridge} workspaceId={workspaceId} tab={tab} onSelect={select} onAuthoringRequest={request} />
  }
  const view = render(<Subject />)
  await screen.findByText("尚未設定 MCP 伺服器")
  expect(request.mock.calls.map(([input]) => input.kind)).toEqual(["desktop/mcp/state"])
  fireEvent.click(screen.getByRole("tab", { name: "命令" }))
  await screen.findByText("尚未建立命令")
  fireEvent.click(screen.getByRole("button", { name: "建立資源" }))
  const destination = screen.getByLabelText("保存位置") as HTMLSelectElement
  expect([destination.value, destination.disabled]).toEqual(["global", true])
  const body = "A shared command draft"
  fireEvent.change(screen.getByLabelText("完整 Markdown（含 frontmatter）"), { target: { value: body } })
  fireEvent.click(screen.getByRole("button", { name: "關閉資源編輯器" }))
  fireEvent.click(screen.getByRole("tab", { name: "插件" }))
  await screen.findByRole("searchbox", { name: "搜尋插件" })
  expect(request.mock.calls.every(([input]) => "workspaceId" in input && input.workspaceId === DESKTOP_CONFIGURATION_ID)).toBe(true)
  fireEvent.click(screen.getByRole("tab", { name: "命令" }))
  fireEvent.click(screen.getByRole("button", { name: "建立資源" }))
  expect((screen.getByLabelText("完整 Markdown（含 frontmatter）") as HTMLTextAreaElement).value).toBe(body)
  view.rerender(<Subject workspaceId="folder-a" />)
  await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/resources/list", workspaceId: "folder-a" })))
  fireEvent.click(screen.getByRole("button", { name: "建立資源" }))
  expect((screen.getByLabelText("保存位置") as HTMLSelectElement).value).toBe("workspace")
  expect((screen.getByLabelText("完整 Markdown（含 frontmatter）") as HTMLTextAreaElement).value).toBe("")
})
