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
  await screen.findByRole("button", { name: /My provider/ })
  expect(screen.getByText("my-model")).toBeTruthy()
  expect(screen.getByText("272000")).toBeTruthy()
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/provider/directory", workspaceId: "w1" })
})

it("shows one provider at a time and scopes connection drafts to that provider", async () => {
  const request = vi.fn().mockResolvedValue([
    { id: "a", displayName: "Alpha", configured: true, baseURL: "https://a.example", auth: { configured: false }, models: [{ id: "alpha-model" }] },
    { id: "b", displayName: "Beta", configured: true, baseURL: "https://b.example", auth: { configured: false }, models: [{ id: "beta-model" }] },
  ])
  render(<ProviderDirectory workspaceId="w1" bridge={{ request, onEvent: () => () => {} }} />)
  await screen.findByRole("button", { name: /Alpha/ })
  expect(screen.queryByText("beta-model")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "編輯提供商" }))
  fireEvent.change(screen.getByLabelText("API 網址"), { target: { value: "https://draft.example" } })
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }))
  expect(screen.queryByText("alpha-model")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "編輯提供商" }))
  expect((screen.getByLabelText("API 網址") as HTMLInputElement).value).toBe("https://b.example")
  expect(request).toHaveBeenCalledTimes(1)
})
