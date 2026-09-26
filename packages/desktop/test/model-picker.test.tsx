// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SessionModelPicker } from "../src/renderer/session/SessionModelPicker.tsx"
afterEach(cleanup)
it("loads routes on demand and submits an explicit session selection", async () => {
  const request = vi.fn().mockResolvedValue([{ id: "p", displayName: "Provider", models: [{ id: "m" }] }])
  const select = vi.fn().mockResolvedValue(undefined)
  render(<SessionModelPicker bridge={{ request, onEvent: () => () => {} }} workspaceId="w" disabled={false} onSelect={select} />)
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  await screen.findByRole("option", { name: "Provider" })
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "p" } })
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "m" } })
  fireEvent.change(screen.getByLabelText("推理強度"), { target: { value: "high" } })
  fireEvent.click(screen.getByRole("button", { name: "套用模型" }))
  await waitFor(() => expect(select).toHaveBeenCalledWith({ provider: "p", model: "m", reasoningEffort: "high" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})
