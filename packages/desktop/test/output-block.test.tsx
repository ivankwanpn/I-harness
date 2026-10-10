// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { OutputBlock } from "../src/renderer/session/OutputBlock.tsx"

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it("copies the complete capture while a long preview stays bounded and exposes every section", async () => {
  const text = "start\n" + "a".repeat(17000) + "middle evidence\n" + "b".repeat(17000) + "\nend"
  const writes: string[] = []
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  const view = render(<OutputBlock label="stdout" text={text} />)
  expect(view.container.querySelector("pre")!.textContent!.length).toBeLessThan(6000)
  expect(screen.queryByText(/middle evidence/)).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "複製 stdout" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "已複製 stdout" })).toBeTruthy())
  expect(writes).toEqual([text])
  fireEvent.click(screen.getByRole("button", { name: "展開 stdout" }))
  fireEvent.click(screen.getByRole("button", { name: "下一段 stdout" }))
  expect(screen.getByText(/middle evidence/)).toBeTruthy()
  expect(view.container.querySelector("pre")!.textContent!.length).toBeLessThanOrEqual(16000)
  fireEvent.click(screen.getByRole("button", { name: "下一段 stdout" }))
  expect(screen.getByText(/end$/)).toBeTruthy()
})

it("only reports copied after the clipboard settles and shows a refused copy", async () => {
  let rejectWrite: (reason: unknown) => void = () => {}
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => new Promise<void>((_resolve, reject) => { rejectWrite = reject }) } })
  render(<OutputBlock label="stderr" text="permission denied" />)
  fireEvent.click(screen.getByRole("button", { name: "複製 stderr" }))
  expect(screen.queryByRole("button", { name: "已複製 stderr" })).toBeNull()
  expect(screen.getByRole("button", { name: "正在複製 stderr" }).hasAttribute("disabled")).toBe(true)
  rejectWrite(new Error("clipboard refused"))
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("clipboard refused"))
  expect(screen.queryByRole("button", { name: "已複製 stderr" })).toBeNull()
  expect(screen.getByRole("button", { name: "複製 stderr" }).hasAttribute("disabled")).toBe(false)
})

it("keeps wrap and expansion controls independent of a surrounding disclosure", () => {
  const toggles: boolean[] = []
  const view = render(<details open onToggle={event => toggles.push(event.currentTarget.open)}><summary>Recorded result</summary><OutputBlock label="source" text={"source\n".repeat(40)} truncated /></details>)
  const wrap = screen.getByRole("button", { name: "自動換行 source" })
  expect(wrap.getAttribute("aria-pressed")).toBe("false")
  fireEvent.click(wrap)
  expect(wrap.getAttribute("aria-pressed")).toBe("true")
  expect(view.container.querySelector("pre")!.classList.contains("output-block-wrap")).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "展開 source" }))
  expect(view.container.querySelector("details")!.open).toBe(true)
  expect(screen.getByText("記錄的輸出已截斷")).toBeTruthy()
  expect(toggles).not.toContain(false)
})

it("does not show an earlier copy as success after the visible capture changes", async () => {
  let resolveWrite: () => void = () => {}
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => new Promise<void>(resolve => { resolveWrite = resolve }) } })
  const view = render(<OutputBlock label="stdout" text="old captured output" />)
  fireEvent.click(screen.getByRole("button", { name: "複製 stdout" }))
  view.rerender(<OutputBlock label="stdout" text="new captured output" />)
  await act(async () => { resolveWrite() })
  expect(screen.queryByRole("button", { name: "已複製 stdout" })).toBeNull()
  expect(screen.getByRole("button", { name: "複製 stdout" }).hasAttribute("disabled")).toBe(false)
})

it("keeps complete Unicode characters at preview and section boundaries", () => {
  const text = "a".repeat(3999) + "😀" + "b".repeat(11998) + "🐈" + "remaining evidence"
  const view = render(<OutputBlock label="unicode" text={text} />)
  expect(view.container.querySelector("pre code")!.textContent!.endsWith("\ud83d")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "展開 unicode" }))
  expect(view.container.querySelector("pre code")!.textContent!.endsWith("\ud83d")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "下一段 unicode" }))
  expect(view.container.querySelector("pre code")!.textContent).toBe("🐈remaining evidence")
})
