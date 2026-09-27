// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { McpSettings } from "../src/renderer/settings/McpSettings.tsx"
afterEach(cleanup)
it("edits public configuration without sending masked private values back", async () => {
  const state = { servers: [{ enabled: true, revision: 2, config: { transport: "stdio", serverName: "local", command: "node", args: ["server.js"] }, secretKeys: ["TOKEN"] }] }
  const request = vi.fn().mockResolvedValue(state)
  render(<McpSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(await screen.findByRole("button", { name: "編輯 MCP 設定" }))
  fireEvent.change(screen.getByLabelText("執行程式"), { target: { value: "node-next" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(request).toHaveBeenCalledWith({ kind: "desktop/mcp/mutate", workspaceId: "w", command: { action: "save", revision: 2, config: { transport: "stdio", serverName: "local", command: "node-next", args: ["server.js"] } } })
})
