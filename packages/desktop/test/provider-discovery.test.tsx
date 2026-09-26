// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderDiscovery } from "../src/renderer/settings/ProviderDiscovery.tsx"
afterEach(cleanup)
it("does not probe or import until explicitly requested", async () => {
  const request = vi.fn().mockResolvedValue([{ id: "m", contextWindow: 272000 }])
  const save = vi.fn().mockResolvedValue(undefined)
  render(<ProviderDiscovery workspaceId="w" id="p" bridge={{ request, onEvent: () => () => {} }} onSave={save} />)
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "探測模型列表" }))
  const checkbox = await screen.findByRole("checkbox")
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole("button", { name: "加入所選模型" }))
  await waitFor(() => expect(save).toHaveBeenCalledWith({ action: "model/add", id: "p", model: "m", fields: { contextWindow: 272000 } }))
  await screen.findByText("已加入 1 個模型")
})
