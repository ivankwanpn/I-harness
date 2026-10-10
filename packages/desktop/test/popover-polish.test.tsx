// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SessionModelPicker } from "../src/renderer/session/SessionModelPicker.tsx"
import { ContextUsage } from "../src/renderer/session/ContextUsage.tsx"
import { TaskList } from "../src/renderer/shell/TaskList.tsx"
afterEach(cleanup)
it("distinguishes the pending model list from no providers and no matching models", async () => {
  let finish!: (value: unknown) => void
  const pending = new Promise(resolve => { finish = resolve })
  render(<SessionModelPicker bridge={{ request: async () => pending, onEvent: () => () => {} }} workspaceId="w" disabled={false} onSelect={async () => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  expect(screen.getByRole("status").textContent).toContain("讀取")
  expect(screen.queryByText("沒有符合的模型")).toBeNull()
  finish([])
  expect(await screen.findByText("尚未設定可用模型；請到模型與提供商設定。" )).toBeTruthy()
})
it.each(["model", "context"])("leaves composition Escape and its late closing key to %s input", async kind => {
  const bridge = { request: vi.fn(async () => []), onEvent: () => () => {} }
  render(kind === "model" ? <SessionModelPicker bridge={bridge} workspaceId="w" disabled={false} onSelect={async () => {}} /> : <ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  fireEvent.click(screen.getByRole("button", { name: kind === "model" ? "選擇模型" : "上下文容量" }))
  const dialog = screen.getByRole("dialog")
  fireEvent.compositionStart(dialog); fireEvent.keyDown(dialog, { key: "Escape", isComposing: true })
  expect(screen.getByRole("dialog")).toBe(dialog)
  fireEvent.compositionEnd(dialog); fireEvent.keyDown(dialog, { key: "Escape" })
  expect(screen.getByRole("dialog")).toBe(dialog)
  fireEvent.keyUp(dialog, { key: "Escape" }); fireEvent.keyDown(dialog, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
})
it("keeps a sidebar rename open while composing", () => {
  render(<TaskList dashboard={{ sessions: [{ id: "s", title: "First", live: false }] }} onSelect={() => {}} onManage={async () => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "更多會話操作 First" }))
  fireEvent.click(screen.getByRole("menuitem", { name: "重新命名" }))
  const field = screen.getByRole("textbox", { name: "會話名稱" })
  fireEvent.compositionStart(field); fireEvent.keyDown(field, { key: "Escape", isComposing: true })
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.compositionEnd(field); fireEvent.keyDown(field, { key: "Escape" })
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.keyUp(field, { key: "Escape" }); fireEvent.keyDown(field, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
})
