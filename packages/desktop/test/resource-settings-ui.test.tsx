// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ResourceSettings } from "../src/renderer/settings/ResourceSettings.tsx"
afterEach(cleanup)
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
