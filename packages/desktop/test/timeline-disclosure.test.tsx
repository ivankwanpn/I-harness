// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
const viewport = vi.hoisted(() => ({ visible: true, scroll: vi.fn() }))
vi.mock("@tanstack/react-virtual", () => ({ elementScroll: () => {}, useVirtualizer: (options: { count: number }) => ({ getTotalSize: () => 200, getVirtualItems: () => viewport.visible ? Array.from({ length:options.count }, (_, index) => ({ index, start: index * 56 })) : [], measureElement: () => {}, scrollToIndex: viewport.scroll, scrollToOffset: () => {} }) }))
import { Timeline } from "../src/renderer/session/Timeline.tsx"
import { projectTimeline } from "../src/renderer/session/project.ts"
afterEach(() => { cleanup(); viewport.visible = true; viewport.scroll.mockClear(); vi.useRealTimers() })

it("renders Markdown before completion and settles in the same assistant row", () => {
  const prefix = [{ type: "step/start" as const, seq: 5 }]
  const rows = projectTimeline(prefix)
  const view = render(<Timeline rows={rows} running assistantPreview={{
    type: "assistant/chunk", stepStartSeq: 5, offset: 0, text: "First **paragraph**",
  }} />)
  const preview = screen.getByText("paragraph").closest(".timeline-row")
  expect(screen.getByText("paragraph").tagName).toBe("STRONG")
  expect(preview?.querySelector(".message-actions")).toBeNull()
  view.rerender(<Timeline rows={rows} running assistantPreview={{
    type: "assistant/chunk", stepStartSeq: 5, offset: 0, text: "First **paragraph**\n\nSecond paragraph",
  }} />)
  expect(screen.getByText("Second paragraph")).toBeTruthy()
  view.rerender(<Timeline rows={projectTimeline([
    ...prefix, { type: "assistant/message", text: "First **paragraph**\n\nSecond paragraph", seq: 6 },
  ])} />)
  expect(screen.getByText("paragraph").closest(".timeline-row")).toBe(preview)
  expect(preview?.querySelector(".message-actions")).toBeTruthy()
  expect(screen.getAllByText("Second paragraph")).toHaveLength(1)
})

it("does not jump to the end when the reader opens tool details", () => {
  vi.useFakeTimers()
  render(<Timeline rows={[{ id: "r", kind: "tool", name: "read", output: "details" }]} />)
  act(() => vi.runOnlyPendingTimers())
  viewport.scroll.mockClear()
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 read" }))
  act(() => vi.runOnlyPendingTimers())
  expect(viewport.scroll).not.toHaveBeenCalled()
})

it("shows an attached user image after sending and opens a larger preview", () => {
  const rows = projectTimeline([{ type: "user/message", text: "What color?", images: [{ mediaType: "image/png", dataBase64: "iVBORw0KGgo=", name: "probe.png" }], seq: 0 }])
  const view = render(<Timeline rows={rows} />)
  expect(screen.getByText("What color?")).toBeTruthy()
  const image = screen.getByRole("img", { name: "probe.png" }) as HTMLImageElement
  expect(image.src).toBe("data:image/png;base64,iVBORw0KGgo=")
  fireEvent.click(screen.getByRole("button", { name: "probe.png" }))
  const dialog = screen.getByRole("dialog")
  expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=")
  expect(dialog.parentElement?.parentElement).toBe(document.body)
  viewport.visible = false
  view.rerender(<Timeline rows={[...rows]} />)
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("owns image preview focus and preserves IME composition before restoring the trigger", () => {
  render(<Timeline rows={[{ id: "image", kind: "message", role: "user", text: "Image", images: [{ mediaType: "image/png", dataBase64: "iVBORw0KGgo=", name: "focus.png" }] }]} />)
  const trigger = screen.getByRole("button", { name: "focus.png" })
  trigger.focus(); fireEvent.click(trigger)
  const dialog = screen.getByRole("dialog", { name: "focus.png" })
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "關閉" }))
  fireEvent.compositionStart(dialog)
  fireEvent.keyDown(document, { key: "Escape", isComposing: true })
  expect(screen.getByRole("dialog")).toBe(dialog)
  fireEvent.compositionEnd(dialog)
  fireEvent.click(screen.getByRole("button", { name: "關閉" }))
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it("collapses intermediate work while keeping the final reply visible", () => {
  const rows = projectTimeline([{ type: "turn/start", seq: 0 }, { type: "user/message", text: "Task", seq: 1 }, { type: "tool/call", callId: "r", name: "read", args: { path: "a.md" }, seq: 2 }, { type: "assistant/message", text: "Final reply", seq: 3 }, { type: "turn/end", seq: 4 }])
  render(<Timeline rows={rows} />)
  expect(screen.queryByRole("button", { name: "工具詳情 read" })).toBeNull()
  expect(screen.getByRole("button", { name: "工作過程" }).getAttribute("aria-expanded")).toBe("false")
  fireEvent.click(screen.getByRole("button", { name: "工作過程" }))
  expect(screen.getByRole("button", { name: "工具詳情 read" })).toBeTruthy()
  expect(screen.getByText("Final reply")).toBeTruthy()
  expect(screen.getByText("Task")).toBeTruthy()
})

it("creates the completed work disclosure only after the turn ends while keeping ongoing exchanges visible", () => {
  const events = [{type:"turn/start" as const,seq:0},{type:"user/message" as const,text:"Task",seq:1},
    {type:"assistant/message" as const,text:"Checking files",seq:2},
    {type:"tool/call" as const,callId:"r",name:"read",args:{path:"a.md"},seq:3},
    {type:"user/message" as const,text:"Also check the dialogs",seq:4}]
  const view=render(<Timeline rows={projectTimeline(events)} running />)
  expect(screen.queryByRole("button",{name:"工作過程"})).toBeNull()
  expect(screen.getByText("Checking files")).toBeTruthy()
  expect(screen.getByText("Also check the dialogs")).toBeTruthy()
  expect(screen.getByRole("button",{name:"工具詳情 read"})).toBeTruthy()
  view.rerender(<Timeline rows={projectTimeline([...events,{type:"assistant/message",text:"Final reply",seq:5},{type:"turn/end",seq:6}])} />)
  expect(screen.getByRole("button",{name:"工作過程"}).getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByText("Checking files")).toBeNull()
  expect(screen.getByText("Final reply")).toBeTruthy()
  expect(screen.getByText("Also check the dialogs")).toBeTruthy()
  fireEvent.click(screen.getByRole("button",{name:"工作過程"}))
  expect(screen.getByText("Checking files")).toBeTruthy()
  expect(screen.getByRole("button",{name:"工具詳情 read"})).toBeTruthy()
})

it("shows persisted model reasoning inside expandable work details", async () => {
  const rows = projectTimeline([
    { type: "turn/start", seq: 0 },
    { type: "user/message", text: "Task", seq: 1 },
    { type: "reasoning", text: "**Inspect** the directory first", seq: 2 },
    { type: "tool/call", callId: "r", name: "read", args: {}, seq: 3 },
    { type: "assistant/message", text: "Done", seq: 4 },
    { type: "turn/end", seq: 5 },
  ])
  render(<Timeline rows={rows} />)
  expect(screen.queryByRole("button", { name: "工具詳情 read" })).toBeNull()
  expect(screen.queryByText("思考過程")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "工作過程" }))
  const disclosure = screen.getByRole("button", { name: "思考過程" })
  expect(disclosure.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByText("Inspect")).toBeNull()
  fireEvent.click(disclosure)
  expect(disclosure.getAttribute("aria-expanded")).toBe("true")
  expect((await screen.findByText("Inspect")).tagName).toBe("STRONG")
})

it("keeps live reasoning compact and preserves an opened segment through the final answer", async () => {
  const prefix = [{ type: "turn/start" as const, seq: 0 }, { type: "user/message" as const, text: "Check the files", seq: 1 }]
  const chunk = { type: "reasoning/chunk" as const, streamId: "a", text: "Inspect the directory\n\nRead", offset: 0, atSeq: 2 }
  const view = render(<Timeline rows={projectTimeline([...prefix, chunk])} running />)
  const disclosure = screen.getByRole("button", { name: "思考中…" })
  expect(disclosure.getAttribute("aria-expanded")).toBe("false")
  expect(screen.getByText("Inspect the directory")).toBeTruthy()
  expect(screen.queryByText("Read")).toBeNull()
  view.rerender(<Timeline rows={projectTimeline([...prefix, chunk, { ...chunk, text: " the files", offset: chunk.text.length }])} running />)
  expect(screen.getByText("Inspect the directory")).toBeTruthy()
  expect(screen.queryByText("Read the files")).toBeNull()
  fireEvent.click(disclosure)
  await screen.findByText("Read the files")
  const reasoning = screen.getByRole("region", { name: "思考過程" })
  expect(reasoning.closest(".timeline")).toBe(screen.getByTestId("timeline"))
  expect(reasoning.hasAttribute("tabindex")).toBe(false)
  view.rerender(<Timeline rows={projectTimeline([...prefix,
    { type: "reasoning", streamId: "a", text: "Inspect the directory\n\nRead the files", seq: 2 },
    { type: "tool/call", callId: "read", name: "read", args: {}, seq: 3 },
    { type: "assistant/message", text: "Done", seq: 4 }, { type: "turn/end", seq: 5 },
  ])} />)
  expect(screen.getByRole("button", { name: "思考過程" })).toBe(disclosure)
  expect(disclosure.getAttribute("aria-expanded")).toBe("true")
  expect(screen.getByRole("button", { name: "工作過程" }).getAttribute("aria-expanded")).toBe("true")
  expect(screen.getByText("Read the files")).toBeTruthy()
  expect(screen.getByText("Done")).toBeTruthy()
})

it("shows measured generation with the final answer and omits a speed on an older turn", () => {
  const rows = projectTimeline([
    { type: "turn/start" }, { type: "user/message", text: "Compare" }, { type: "step/start" },
    { type: "assistant/message", text: "" }, { type: "step/end", generation: { outputTokens: 90, generationMs: 3_000 } },
    { type: "step/start" }, { type: "assistant/message", text: "Final result" },
    { type: "step/end", generation: { outputTokens: 60, generationMs: 1_000 } }, { type: "turn/end" },
    { type: "turn/start" }, { type: "assistant/message", text: "Older style record" }, { type: "step/end" }, { type: "turn/end" },
  ])
  render(<Timeline rows={rows} historical />)
  const speed = screen.getByText("37.5 tok/s")
  expect(speed.closest(".timeline-message")?.textContent).toContain("Final result")
  expect(speed.getAttribute("title")).toContain("150 輸出 Token")
  expect(screen.getByText("Older style record").closest(".timeline-message")?.textContent).not.toContain("tok/s")
})

it("keeps a classified failure visible with the interrupted answer after the turn closes", () => {
  render(<Timeline rows={projectTimeline([
    { type: "turn/start" }, { type: "step/start" }, { type: "assistant/message", text: "Partial reply" },
    { type: "step/failed", failure: { code: "RATE_LIMIT", httpStatus: 429 } }, { type: "step/end" }, { type: "turn/end" },
  ])} />)
  expect(screen.getByText("中斷前的回覆")).toBeTruthy()
  expect(screen.getByText("供應商暫時限制請求。請稍後重試。")).toBeTruthy()
  expect(screen.getByText("HTTP 429")).toBeTruthy()
})

it("keeps inner and outer disclosure choices across growth and virtual unmount", () => {
  const a = { id: "a", kind: "tool" as const, name: "read", args: { path: "a.txt" }, output: "first contents" }
  const b = { ...a, id: "b", name: "list_dir", output: "directory listing" }
  const view = render(<Timeline rows={[a, b]} />)
  expect(screen.queryByRole("button", { name: "工具詳情 read" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "查閱 2" }))
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 read" }))
  expect(screen.getByText("first contents")).toBeTruthy()
  view.rerender(<Timeline rows={[a, b, { ...b, id: "c" }]} />)
  expect(screen.getByText("first contents")).toBeTruthy()
  viewport.visible = false
  view.rerender(<Timeline rows={[a, b]} />)
  expect(screen.queryByText("first contents")).toBeNull()
  viewport.visible = true
  view.rerender(<Timeline rows={[a, b]} />)
  expect(screen.getByText("first contents")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "查閱 2" }))
  expect(screen.queryByText("first contents")).toBeNull()
})

it("returns to the inspected tool's page after virtual unmount", () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({ id: String(index), kind: "tool" as const, name: "read", output: `contents-${index}` }))
  const view = render(<Timeline rows={rows} />)
  fireEvent.click(screen.getByRole("button", { name: "查閱 51" }))
  fireEvent.click(screen.getByRole("button", { name: "下一頁" }))
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 read" }))
  expect(screen.getByText("contents-50")).toBeTruthy()
  viewport.visible = false; view.rerender(<Timeline rows={[...rows]} />)
  viewport.visible = true; view.rerender(<Timeline rows={[...rows]} />)
  expect(screen.getByText("contents-50")).toBeTruthy()
})
