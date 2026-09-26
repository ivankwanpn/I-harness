// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { TitleBar } from "../src/renderer/shell/TitleBar.tsx"
import { NativeSettings } from "../src/renderer/settings/NativeSettings.tsx"
afterEach(cleanup)
it("sends only the selected native window action", () => {
  const request = vi.fn(async () => ({}))
  render(<TitleBar bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(screen.getByRole("button", { name: "最小化視窗" }))
  expect(request).toHaveBeenCalledWith({ kind: "window/control", action: "minimize" })
})
it("reads and updates notification preferences and can reset window bounds", async () => {
  const request = vi.fn(async () => ({ notifications: false, notificationsSupported: true }))
  render(<NativeSettings bridge={{ request, onEvent: () => () => {} }} />)
  await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("checkbox"))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/local/configure", notifications: true, locale: "zh-TW" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "重設視窗" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "重設視窗" }))
  expect(request).toHaveBeenCalledWith({ kind: "window/reset-bounds" })
})
