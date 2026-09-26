// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { CompactionPanel } from "../src/renderer/session/CompactionPanel.tsx"
afterEach(cleanup)

it("submits retention instructions and exposes cancellation during compaction", () => {
  const onCompact = vi.fn(async () => {})
  const onCancel = vi.fn()
  const view = render(<CompactionPanel disabled={false} onCompact={onCompact} onCancel={onCancel} />)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "保留測試結果" } })
  fireEvent.click(screen.getByRole("button", { name: "開始壓縮" }))
  expect(onCompact).toHaveBeenCalledWith("保留測試結果")
  view.rerender(<CompactionPanel operation={{ kind: "compact", busy: true }} disabled onCompact={onCompact} onCancel={onCancel} />)
  fireEvent.click(screen.getByRole("button", { name: "停止" }))
  expect(onCancel).toHaveBeenCalledTimes(1)
})

it("does not label summarizer failure as an empty or successful compaction", () => {
  render(<CompactionPanel operation={{ kind: "compact", busy: false, result: { compacted: false, reason: "summarizer-failed" } }} disabled={false} onCompact={async () => {}} onCancel={() => {}} />)
  expect(screen.getByRole("status").textContent).toBe("摘要產生失敗，未完成壓縮。")
})

it("checks the UTF-8 byte limit before submitting", () => {
  const onCompact = vi.fn(async () => {})
  render(<CompactionPanel disabled={false} onCompact={onCompact} onCancel={() => {}} />)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "中".repeat(1400) } })
  fireEvent.click(screen.getByRole("button", { name: "開始壓縮" }))
  expect(onCompact).not.toHaveBeenCalled()
  expect(screen.getByRole("alert")).toBeTruthy()
})
