// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { HookSettings } from "../src/renderer/settings/HookSettings.tsx"
afterEach(cleanup)
it("requires reviewing the exact script grant before sending approval", async () => {
  const sha256 = "a".repeat(64)
  const state = { handlers: [{ id: "h", name: "observe", event: "pre-tool", configPath: "plugin/hooks.json", script: "plugin/hook.cjs", sha256, status: "needs-approval" }], grants: [], errors: [] }
  const request = vi.fn().mockResolvedValue(state)
  render(<HookSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  fireEvent.click(await screen.findByRole("button", { name: "批准腳本" }))
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.getAllByText(sha256).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole("button", { name: "確認授權此內容" }))
  expect(request).toHaveBeenCalledWith({ kind: "desktop/hooks/mutate", workspaceId: "w", command: { action: "approve", id: "h", sha256 } })
})
