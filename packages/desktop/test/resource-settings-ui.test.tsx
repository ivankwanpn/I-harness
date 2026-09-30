// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ResourceSettings } from "../src/renderer/settings/ResourceSettings.tsx"
afterEach(cleanup)
it("does not reopen a preview after a pending read was closed", async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise((done) => { resolve = done })
  const request = vi.fn(async (input) => input.kind.endsWith("/list") ? { items: [{ name: "slow", source: "global" }], total: 1, diagnostics: [] } : pending)
  render(<ResourceSettings resourceKind="skills" workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(await screen.findByRole("button", { name: "slow" }))
  const close = screen.getByRole("button", { name: "關閉內容預覽" })
  await waitFor(() => expect(document.activeElement).toBe(close))
  fireEvent.keyDown(close, { key: "Escape" })
  await act(async () => { resolve({ name: "slow", source: "global", body: "Late content", truncated: false }); await pending })
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.queryByText("Late content")).toBeNull()
})
it("keeps Markdown links reachable within the dialog's focus trap", async () => {
  const request = vi.fn(async (input) => input.kind.endsWith("/list") ? { items: [{ name: "linked", source: "global" }], total: 1, diagnostics: [] }
    : { name: "linked", source: "global", body: "[Documentation](https://example.com/docs)", truncated: false })
  render(<ResourceSettings resourceKind="skills" workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onUse={() => {}} />)
  fireEvent.click(await screen.findByRole("button", { name: "linked" }))
  const link = await screen.findByRole("link", { name: "Documentation" })
  const use = screen.getByRole("button", { name: "使用此技能" })
  use.focus()
  expect(fireEvent.keyDown(use, { key: "Tab" })).toBe(true)
  link.focus()
  expect(fireEvent.keyDown(link, { key: "Tab" })).toBe(false)
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "關閉內容預覽" }))
})
it("shows skills as readable cards and loads a detail dialog only on selection", async () => {
  const name = "a-very-long-skill-name-that-needs-to-remain-readable"
  const request = vi.fn(async (input) => input.kind.endsWith("/list") ? { items: [{ name, source: "plugin", pluginId: "superpowers", description: "Useful skill" }], total: 1, diagnostics: [] }
    : { name, source: "plugin", pluginId: "superpowers", body: "# Skill content", truncated: false })
  render(<ResourceSettings resourceKind="skills" workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  await screen.findByRole("button", { name })
  expect(screen.getByRole("list", { name: "技能列表" })).toBeTruthy()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name }))
  expect(await screen.findByRole("dialog", { name })).toBeTruthy()
  expect(await screen.findByText("Skill content")).toBeTruthy()
})
it("loads bodies only when selected and inserts a command without submitting it", async () => {
  const request = vi.fn(async (request) => request.kind.endsWith("/list") ? { items: [{ name: "hello", source: "plugin", pluginId: "fixture", description: "Greet" }], total: 1, diagnostics: [] } : { name: "hello", source: "plugin", pluginId: "fixture", body: "Do $ARGUMENTS", truncated: false, unsupported: ["allowed-tools"] })
  const use = vi.fn(), manage = vi.fn()
  render(<ResourceSettings resourceKind="commands" workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onUse={use} onManagePlugins={manage} />)
  await screen.findByRole("button", { name: "hello" })
  expect(request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "hello" }))
  await screen.findByText("Do $ARGUMENTS")
  expect(screen.getByText(/allowed-tools/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "帶入此命令" }))
  expect(use).toHaveBeenCalledWith("/hello ")
  fireEvent.click(screen.getByRole("button", { name: "管理來源插件" }))
  expect(manage).toHaveBeenCalledWith("fixture")
})
