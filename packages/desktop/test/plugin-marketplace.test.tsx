// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { PluginMarketplace } from "../src/renderer/settings/PluginMarketplace.tsx"
afterEach(cleanup)
it("keeps an installation failure visible after refreshing the catalog", async () => {
  const request = vi.fn(async (value) => {
    if (value.kind === "desktop/plugins/mutate") throw new Error("install failed")
    return { sources: [], plugins: [{ id: "p", name: "Example", installed: false, enabled: false }] }
  })
  render(<PluginMarketplace bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  fireEvent.click(await screen.findByRole("button", { name: "安裝" }))
  await waitFor(() => expect(request.mock.calls.filter(([value]) => value.kind === "desktop/plugins/state")).toHaveLength(2))
  expect(screen.getByRole("alert").textContent).toContain("install failed")
})
it("reads cached state and requires confirmation before uninstalling", async () => {
  const request = vi.fn(async (value) => value.kind === "desktop/plugins/state" ? { sources: [], plugins: [{ id: "m__p", name: "Example", installed: true, enabled: true }] } : { ok: true })
  render(<PluginMarketplace bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  fireEvent.click(await screen.findByRole("button", { name: "卸載" }))
  expect(request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "確認卸載" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/plugins/mutate", workspaceId: "w", command: { action: "uninstall", id: "m__p" } }))
})
it("filling the official source does not install or fetch it", async () => {
  const request = vi.fn().mockResolvedValue({ sources: [], plugins: [] })
  render(<PluginMarketplace bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  await screen.findByText("沒有符合的插件；可先加入市場來源。")
  fireEvent.click(screen.getByText("管理市場來源"))
  fireEvent.click(screen.getByRole("button", { name: "填入官方市場來源" }))
  expect((screen.getByLabelText("來源網址或本機路徑") as HTMLInputElement).value).toBe("anthropics/claude-plugins-official")
  expect(request).toHaveBeenCalledTimes(1)
})

it("keeps the catalog compact and reveals the full plugin description on demand", async () => {
  const description = "A long plugin description for daily work. ".repeat(18)
  const request = vi.fn().mockResolvedValue({ sources: [], plugins: [{ id: "official__example", name: "Example", description, installed: false, enabled: false, conflicts: [{ name: "tool", reason: "incompatible" }] }] })
  render(<PluginMarketplace bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  await screen.findByRole("button", { name: "查看插件詳情 Example" })
  expect(screen.queryByText(description.trim())).toBeNull()
  expect(screen.getByRole("button", { name: "安裝" })).toBeTruthy()
  expect(screen.getByRole("alert").textContent).toContain("incompatible")
  fireEvent.click(screen.getByRole("button", { name: "查看插件詳情 Example" }))
  expect(screen.getByText(description.trim())).toBeTruthy()
  expect(screen.getByText("official__example")).toBeTruthy()
  expect(request).toHaveBeenCalledTimes(1)
})
