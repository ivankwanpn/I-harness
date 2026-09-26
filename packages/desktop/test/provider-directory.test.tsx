// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderDirectory } from "../src/renderer/settings/ProviderDirectory.tsx"

afterEach(cleanup)
it("loads real directory metadata and supports retry without discovering models", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([{
    id: "local-route", displayName: "My provider", auth: { configured: true },
    models: [{ id: "my-model", contextWindow: 272000 }],
  }])
  render(<ProviderDirectory workspaceId="w1" bridge={{ request, onEvent: () => () => {} }} />)
  await screen.findByText("offline")
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await screen.findByText("My provider")
  expect(screen.getByText("my-model")).toBeTruthy()
  expect(screen.getByText("272000")).toBeTruthy()
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/provider/directory", workspaceId: "w1" })
})
