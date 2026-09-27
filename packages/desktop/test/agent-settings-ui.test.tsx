// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { AgentSettings } from "../src/renderer/settings/AgentSettings.tsx"
afterEach(cleanup)
it("saves an explicit change and shows the still-effective runtime policy", async () => {
  const initial = { saved: { sandboxMode: "read-only", autoCompaction: true }, effective: { sandboxMode: "read-only", autoCompaction: true }, restartRequired: false, source: "settings" }
  const request = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, saved: { ...initial.saved, autoCompaction: false }, restartRequired: true })
  render(<AgentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  const toggle = await screen.findByRole("checkbox", { name: "自動壓縮上下文" })
  fireEvent.click(toggle)
  expect(request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByText("重啟 Desktop 後套用；目前執行中的 Agent 保持原設定。")
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/agent-settings/configure", workspaceId: "w", patch: { autoCompaction: false } })
})
