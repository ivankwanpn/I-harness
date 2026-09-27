// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ToolActivity } from "../src/renderer/session/ToolActivity.tsx"
afterEach(cleanup)

it("opens an explicit file target through the workspace review callback", () => {
  const onOpenFile = vi.fn()
  render(<ToolActivity name="read" args={{ path: "D:/repo/a.md" }} navigation={{ workspacePath: "D:/repo", onOpenFile }} />)
  fireEvent.click(screen.getByRole("button", { name: "在成果面板開啟 a.md" }))
  expect(onOpenFile).toHaveBeenCalledWith("a.md")
  expect(screen.getByRole("button", { name: "工具詳情 read" }).getAttribute("aria-expanded")).toBe("false")
})

it("reveals the actual invocation as well as its result", () => {
  render(<ToolActivity name="bash" args={{ command: "pwd" }} output="D:/playground" />)
  expect(screen.queryByText(/pwd/)).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 bash" }))
  expect(screen.getByText(/pwd/)).toBeTruthy()
  expect(screen.getByText("D:/playground")).toBeTruthy()
})

it("does not serialize tool output until details are expanded", () => {
  const toJSON = vi.fn(() => ({ detail: "readable result" }))
  render(<ToolActivity name="read_file" output={{ toJSON }} />)
  expect(toJSON).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 read_file" }))
  expect(toJSON).toHaveBeenCalledTimes(1)
  expect(screen.getByText(/readable result/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 read_file" }))
  expect(screen.queryByText(/readable result/)).toBeNull()
})

it("distinguishes pending output from a returned failure without inventing success", () => {
  const view = render(<ToolActivity name="write_file" />)
  expect(screen.getByText("尚未回報結果")).toBeTruthy()
  view.rerender(<ToolActivity name="write_file" output={{ error: "permission denied" }} />)
  expect(screen.getByText("執行失敗")).toBeTruthy()
  expect(screen.queryByText("成功")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 write_file" }))
  expect(screen.getByText(/permission denied/)).toBeTruthy()
})

it("shows an image result without rendering its base64 bytes as text", () => {
  const dataBase64 = "aGVsbG8="
  render(<ToolActivity name="read_image" output={{ images: [{ mediaType: "image/png", dataBase64, name: "probe.png" }] }} />)
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 read_image" }))
  const image = screen.getByRole("img", { name: "probe.png" }) as HTMLImageElement
  expect(image.getAttribute("src")).toBe(`data:image/png;base64,${dataBase64}`)
  expect(screen.queryByText(/aGVsbG8=/)).toBeNull()
  expect(screen.getByText(/image\/png/)).toBeTruthy()
  expect(screen.getByText(/"bytes": 5/)).toBeTruthy()
})

it("shows a received failure even when its output is undefined", () => {
  render(<ToolActivity name="plugin_noop" output={undefined} resultReceived isError />)
  expect(screen.getByText("執行失敗")).toBeTruthy()
})
