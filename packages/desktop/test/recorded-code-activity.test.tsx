// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: (options: { count: number }) => ({ getTotalSize: () => 200, getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, start: index * 56 })), measureElement: () => {}, scrollToIndex: () => {} }) }))
import { Timeline } from "../src/renderer/session/Timeline.tsx"
import { projectHistoryTimeline, projectTimeline, type WireEvent } from "../src/renderer/session/project.ts"

afterEach(cleanup)

it("keeps 150k Code Mode text out of the closed DOM and copies the full historical output", async () => {
  const text = "owned beginning\n" + "captured text ".repeat(12000) + "\nowned ending"
  const writes: string[] = []
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  const event: WireEvent = { type: "code/output", cellId: "cell-text", content: { type: "text", text }, seq: 90 }
  const rows = projectHistoryTimeline([event])
  const view = render(<Timeline rows={rows} historical />)
  expect(view.container.textContent!.length).toBeLessThan(1000)
  expect(view.container.querySelector("pre")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Code Mode 輸出 cell-text" }))
  expect(view.container.textContent!.length).toBeLessThan(6000)
  fireEvent.click(screen.getByRole("button", { name: "複製 Code Mode 輸出" }))
  await waitFor(() => expect(writes).toEqual([text]))
})

it("keeps store payloads unformatted until expansion and bounds the visible candidate without losing its copy", async () => {
  let serialized = 0
  const text = "s".repeat(150000), writes: string[] = []
  const value = { text, metadata: 7, toJSON() { serialized++; return { text, metadata: 7 } } }
  const event: WireEvent = { type: "code/store", version: 1, cellId: "cell-store", writes: [["owned-key", value]], seq: 8 }
  const rows = projectTimeline([event])
  expect(serialized).toBe(0)
  const view = render(<Timeline rows={rows} />)
  expect(serialized).toBe(0)
  expect(view.container.querySelector("pre")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Code Mode 儲存候選 cell-store" }))
  expect(serialized).toBe(1)
  expect(view.container.textContent!.length).toBeLessThan(6000)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  fireEvent.click(screen.getByRole("button", { name: "複製 儲存候選資料" }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(JSON.parse(writes[0]!)).toEqual([["owned-key", { text, metadata: 7 }]])
  expect(screen.queryByText(/已保存|已提交/)).toBeNull()
})

it("keeps large cell source and error lazy and bounded while preserving both complete copies", async () => {
  const source = "text('owned');\n".repeat(12000), error = "actual error detail\n".repeat(9000), writes: string[] = []
  const view = render(<Timeline rows={projectTimeline([{ type: "code/cell", cellId: "cell-source", parentCallId: "outer-owned", state: "failed", source, error, seq: 2 }])} />)
  expect(view.container.querySelector("pre")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Code Mode 執行單元 cell-source" }))
  expect(view.container.textContent!.length).toBeLessThan(10000)
  expect(screen.getByText("outer-owned")).toBeTruthy()
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  fireEvent.click(screen.getByRole("button", { name: "複製 JavaScript 原始碼" }))
  await waitFor(() => expect(writes).toEqual([source]))
  fireEvent.click(screen.getByRole("button", { name: "複製 錯誤記錄" }))
  await waitFor(() => expect(writes).toEqual([source, error]))
})

it("recognizes an orphan image output without exposing base64 text and preserves its full raw record", async () => {
  const dataBase64 = "A".repeat(160000), writes: string[] = []
  const event: WireEvent = { type: "code/output", cellId: "cell-image", content: { type: "image", image: { mediaType: "image/png", dataBase64, name: "owned.png" } }, seq: 90 }
  const view = render(<Timeline rows={projectHistoryTimeline([event])} historical />)
  expect(view.container.textContent!.length).toBeLessThan(1000)
  expect(screen.queryByRole("img")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Code Mode 輸出 cell-image" }))
  expect(view.container.textContent!.length).toBeLessThan(3000)
  expect(screen.getByRole("img", { name: "owned.png" }).getAttribute("src")).toBe(`data:image/png;base64,${dataBase64}`)
  fireEvent.click(screen.getByRole("button", { name: "owned.png" }))
  expect(screen.getByRole("dialog").querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${dataBase64}`)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  fireEvent.click(screen.getByText("原始記錄"))
  fireEvent.click(screen.getByRole("button", { name: "複製 原始記錄資料" }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(JSON.parse(writes[0]!)).toEqual(event)
})

it("recognizes captured audio only after expansion without autoplay or remote media loading", async () => {
  const audioUrl = `data:audio/wav;base64,${"A".repeat(150000)}`, writes: string[] = []
  const event: WireEvent = { type: "code/output", cellId: "cell-audio", content: { type: "audio", audioUrl }, seq: 90 }
  const view = render(<Timeline rows={projectHistoryTimeline([event])} historical />)
  expect(view.container.textContent!.length).toBeLessThan(1000)
  expect(view.container.querySelector("audio")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Code Mode 輸出 cell-audio" }))
  const audio = view.container.querySelector("audio")!
  expect(audio.getAttribute("src")).toBe(audioUrl)
  expect(audio.hasAttribute("controls")).toBe(true)
  expect(audio.getAttribute("preload")).toBe("none")
  expect(audio.hasAttribute("autoplay")).toBe(false)
  expect(view.container.textContent!.length).toBeLessThan(2000)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  fireEvent.click(screen.getByText("原始記錄"))
  fireEvent.click(screen.getByRole("button", { name: "複製 原始記錄資料" }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(JSON.parse(writes[0]!)).toEqual(event)
})
