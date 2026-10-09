// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ApplicationInformation } from "../src/renderer/settings/ApplicationInformation.tsx"

afterEach(cleanup)
it("waits for copy acknowledgement, blocks duplicate clicks and shows rejection before a successful retry", async () => {
  let reject!: (error: Error) => void
  const pending = new Promise((_, fail) => { reject = fail })
  const copy = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ copied: true })
  const request = vi.fn(async (input: any) => input.kind === "desktop/about/info" ? { version: "owned", node: "24", electron: "44", platform: "win32", arch: "x64", packaged: true } : copy())
  render(<ApplicationInformation bridge={{ request, onEvent: () => () => {} }} />)
  await screen.findByText("owned")
  fireEvent.click(screen.getByRole("button", { name: "複製" }))
  const busy = screen.getByRole("button", { name: "複製中…" }) as HTMLButtonElement
  expect(busy.disabled).toBe(true)
  fireEvent.click(busy)
  expect(copy).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole("button", { name: "已複製" })).toBeNull()
  await act(async () => reject(new Error("clipboard unavailable")))
  expect((await screen.findByRole("alert")).textContent).toContain("clipboard unavailable")
  fireEvent.click(screen.getByRole("button", { name: "複製" }))
  await screen.findByRole("button", { name: "已複製" })
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
})
