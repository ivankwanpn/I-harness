// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { DiagnosticsPane } from "../src/renderer/settings/DiagnosticsPane.tsx"

afterEach(cleanup)
it("ends the initial loading state after a failed read and offers a read-only retry", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("diagnostics unavailable")).mockResolvedValue({ live: false, executables: [], tools: [], roles: [] })
  render(<DiagnosticsPane bridge={{ request }} workspaceId="owned" />)
  expect((await screen.findByRole("alert")).textContent).toContain("diagnostics unavailable")
  expect(screen.queryByText("正在讀取…")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/environment/diagnostics", workspaceId: "owned", probe: false })
})
