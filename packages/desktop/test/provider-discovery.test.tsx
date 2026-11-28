// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderDiscovery } from "../src/renderer/settings/ProviderDiscovery.tsx"
afterEach(cleanup)
it.each([
  { contextWindow: 272000, protocol: "anthropic-messages" },
  { inputTokenLimit: 65536, outputTokenLimit: 8192, protocol: "gemini" },
])("imports explicitly selected $protocol model fields unchanged", async (fields) => {
  const request = vi.fn().mockResolvedValue([{ id: "m", ...fields }])
  const save = vi.fn().mockResolvedValue(undefined)
  render(<ProviderDiscovery workspaceId="w" id="p" bridge={{ request, onEvent: () => () => {} }} onSave={save} />)
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "探索模型" }))
  const checkbox = await screen.findByRole("checkbox")
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole("button", { name: "加入所選模型" }))
  await waitFor(() => expect(save).toHaveBeenCalledWith({ action: "model/add", id: "p", model: "m", fields }))
  await screen.findByText("已加入 1 個模型")
})
