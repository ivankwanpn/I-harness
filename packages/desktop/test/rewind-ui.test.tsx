// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { RewindPanel } from "../src/renderer/session/RewindPanel.tsx"
afterEach(cleanup)
it("requires preview and acknowledgement before executing and clears consent when scope changes", async () => {
  const request = vi.fn(async (value) => value.kind.endsWith("/points") ? [{ turnIndex: 0, preview: "first", files: 1 }] : value.kind.endsWith("/plan") ? { fingerprint: "a".repeat(64), ops: [{ path: "a.txt", kind: "restore-blob" }], conflicts: [{ path: "a.txt", kind: "modified" }], unTracked: ["shell.txt"] } : { revertedFiles: 1, errors: [], eventAppended: true })
  const complete = vi.fn()
  render(<RewindPanel bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" onComplete={complete} onClose={() => {}} />)
  await screen.findByRole("option", { name: "1 · first" })
  fireEvent.change(screen.getByLabelText("回復點"), { target: { value: "0" } })
  expect(screen.queryByRole("button", { name: "確認回復" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "預覽回復" }))
  const confirm = await screen.findByRole("button", { name: "確認回復" }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  expect(screen.getByText("shell.txt")).toBeTruthy()
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.change(screen.getByLabelText("回復範圍"), { target: { value: "files" } })
  expect(screen.queryByRole("button", { name: "確認回復" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "預覽回復" }))
  await screen.findByRole("checkbox")
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(screen.getByRole("button", { name: "確認回復" }))
  await waitFor(() => expect(complete).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith({ kind: "desktop/rewind/execute", workspaceId: "w", sessionId: "s", target: 0, mode: "files", fingerprint: "a".repeat(64) })
})
