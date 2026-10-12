// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { Composer, ComposerPreparationError } from "../src/renderer/session/Composer.tsx"
afterEach(cleanup)
it("retains a rejected prompt draft while moving remote failure text out of the composer", async () => {
  render(<Composer workspaceId="runtime-w" sessionId="runtime-s" canSend running={false} executionError="raw remote body" onPrompt={async () => { throw Error("raw provider response") }} onCancel={() => {}} />)
  expect(screen.queryByText("raw remote body")).toBeNull()
  const input = screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: "keep draft" } }); fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(false))
  expect(input.value).toBe("keep draft"); expect(screen.queryByText("raw provider response")).toBeNull()
})
it("preserves local compact validation in the composer", async () => {
  render(<Composer workspaceId="validation-w" sessionId="validation-s" canSend running={false} onPrompt={async () => {}} onCancel={() => {}} />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "/compact" } }); fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await screen.findByText("目前無法壓縮上下文")
})
it("preserves safe local request-preparation errors even when the submit callback rejects", async () => {
  render(<Composer workspaceId="prep-w" sessionId="prep-s" canSend running={false} onPrompt={async () => { throw new ComposerPreparationError("Safe local preparation failure") }} onCancel={() => {}} />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "keep prepared draft" } }); fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await screen.findByText("Safe local preparation failure")
})
it("routes remote compaction failures out of the composer while retaining the command", async () => {
  render(<Composer workspaceId="compact-w" sessionId="compact-s" canSend running={false} canCompact onCompact={async () => { throw Error("private compact model body") }} onPrompt={async () => {}} onCancel={() => {}} />)
  const input = screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: "/compact summarize" } }); fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByText("private compact model body")).toBeNull(); expect(input.value).toBe("/compact summarize")
})
