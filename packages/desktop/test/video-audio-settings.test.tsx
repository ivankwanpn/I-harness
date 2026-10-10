// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderCard } from "../src/renderer/settings/ProviderCard.tsx"
afterEach(cleanup)
it("sets an explicit separate audio model and can disable it", async () => {
  const save = vi.fn(async () => {})
  const row = { id: "route", displayName: "Audio route", protocol: "openai-responses" as const, configured: true, auth: { configured: true }, models: [], videoAudioModel: "previous" }
  render(<ProviderCard row={row} onSave={save} />)
  fireEvent.change(screen.getByLabelText("影片音訊模型"), { target: { value: "audio-model" } })
  fireEvent.click(screen.getByRole("button", { name: "用於影片音訊" }))
  await waitFor(() => expect(save).toHaveBeenCalledWith({ action: "video-audio/set", id: "route", model: "audio-model" }))
  fireEvent.click(screen.getByRole("button", { name: "停用音訊分析" }))
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ action: "video-audio/set", id: "route", model: null }))
})
