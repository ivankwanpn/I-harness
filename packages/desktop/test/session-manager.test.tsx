// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SessionManager } from "../src/renderer/session/SessionManager.tsx"
afterEach(cleanup)
it("requires confirmation to archive and reads a separate restore list", async () => {
  const request = vi.fn(async (value) => value.kind === "session/list" ? { sessions: [{ id: "s", title: "Example" }] } : [{ id: "s", title: "Example" }])
  const manage = vi.fn().mockResolvedValue(undefined)
  render(<SessionManager workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onManage={manage} />)
  fireEvent.click(await screen.findByRole("button", { name: "封存會話" }))
  expect(manage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "確認封存" }))
  await waitFor(() => expect(manage).toHaveBeenCalledWith("s", "archive", undefined))
  await waitFor(() => expect((screen.getByRole("button", { name: "已封存會話" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "已封存會話" }))
  fireEvent.click(await screen.findByRole("button", { name: "還原會話" }))
  await waitFor(() => expect(manage).toHaveBeenCalledWith("s", "restore", undefined))
})
it("keeps the proposed name when saving fails", async () => {
  const request = vi.fn().mockResolvedValue({ sessions: [{ id: "s", title: "Old" }] })
  render(<SessionManager workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onManage={async () => { throw new Error("busy") }} />)
  fireEvent.click(await screen.findByRole("button", { name: "重新命名" }))
  fireEvent.change(screen.getByLabelText("會話名稱"), { target: { value: "New" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByRole("alert")
  expect((screen.getByLabelText("會話名稱") as HTMLInputElement).value).toBe("New")
})
