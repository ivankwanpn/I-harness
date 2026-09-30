// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { AgentShellSettings } from "../src/renderer/settings/AgentShellSettings.tsx"
afterEach(cleanup)
const options = [
  { id: "auto", label: "自動選擇", command: "D:/Git/bin/bash.exe", dialect: "posix" },
  { id: "pwsh", label: "PowerShell 7", command: "D:/PowerShell/pwsh.exe", dialect: "powershell" },
]
it("saves the Agent shell independently and displays the effective executable", async () => {
  const request = vi.fn().mockResolvedValueOnce({ selected: "auto", options, resolved: options[0] })
    .mockResolvedValueOnce({ selected: "pwsh", options, resolved: options[1] })
  render(<AgentShellSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.change(await screen.findByRole("combobox", { name: "Agent Shell" }), { target: { value: "pwsh" } })
  await screen.findByText("D:/PowerShell/pwsh.exe")
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/agent-shell/configure", workspaceId: "w", patch: { shell: "pwsh" } })
  expect((screen.getByRole("combobox", { name: "Agent Shell" }) as HTMLSelectElement).value).toBe("pwsh")
})
it("keeps the saved choice when a configuration write fails", async () => {
  const request = vi.fn().mockResolvedValueOnce({ selected: "auto", options, resolved: options[0] }).mockRejectedValueOnce(new Error("write failed"))
  render(<AgentShellSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.change(await screen.findByRole("combobox", { name: "Agent Shell" }), { target: { value: "pwsh" } })
  await screen.findByRole("alert")
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Agent Shell" }) as HTMLSelectElement).value).toBe("auto"))
})
it("shows a saved unavailable selection so it can be replaced", async () => {
  const request = vi.fn().mockResolvedValue({ selected: "cmd", options, error: "Agent Shell 'cmd' is unavailable" })
  render(<AgentShellSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  expect((await screen.findByRole("combobox", { name: "Agent Shell" }) as HTMLSelectElement).value).toBe("cmd")
  expect(await screen.findByRole("alert")).toBeTruthy()
})
