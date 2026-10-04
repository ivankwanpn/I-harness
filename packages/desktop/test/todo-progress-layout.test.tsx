// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { render } from "@testing-library/react"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { TodoProgressProps } from "../src/renderer/session/TodoProgress.tsx"
import type { DesktopBridge } from "../src/shared/bridge.ts"

// Opt into real browser geometry without adding a browser download to unit tests.
// IH_TODO_LAYOUT_PLAYWRIGHT is an installed playwright-core module entry point.
const playwrightModule = process.env.IH_TODO_LAYOUT_PLAYWRIGHT
const browserExecutable = process.env.IH_TODO_LAYOUT_BROWSER
interface BrowserPage {
  setViewportSize(size: { width: number; height: number }): Promise<void>
  setContent(html: string): Promise<void>
  evaluate<T>(callback: () => T): Promise<T>
}
interface GeometryBrowser { newPage(): Promise<BrowserPage>; close(): Promise<void> }
let browser: GeometryBrowser | undefined

const css = ["design/tokens.css", "vendor/zcode/styles.css", "session/Composer.css", "session/TodoProgress.css"]
  .map((path) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer", path), "utf8"))
  .join("\n")
const workspace = { id: "todo-geometry", path: "D:/synthetic-todo-geometry", label: "Todo geometry" }
const bridge: DesktopBridge = { request: async () => undefined, onEvent: () => () => {} }
const seven = [
  { content: "環境盤點：系統/已安裝工具/套件與 CLI ✅", status: "completed" as const },
  { content: "檢查命令工具（exec_command / shell / powershell / 背景程序）", status: "completed" as const },
  { content: "檢查檔案工具（read/write/edit/apply_patch/view_image/list_directory）", status: "completed" as const },
  { content: "檢查搜尋工具 🔎（skill/tool/memory/session 搜尋與網頁讀取）", status: "completed" as const },
  { content: "檢查編排工具：子代理/團隊/待辦/目標/排程與工作狀態", status: "completed" as const },
  { content: "確認長路徑 D:/workspace/packages/desktop/src/renderer/session/TodoProgress.tsx 🧪", status: "in_progress" as const },
  { content: `確認沒有空白的工具名稱 ${"very_long_ASCII_tool_name".repeat(12)}`, status: "pending" as const },
]

function markup(todos: TodoProgressProps["todos"], sidebarCollapsed: boolean, reviewOpen: boolean) {
  const saved = useUiStore.getState()
  useUiStore.setState({ sidebarCollapsed, reviewOpen, surface: "conversation" })
  try {
    const view = render(<Workbench bridge={bridge} workspaces={[workspace]} selectedWorkspaceId={workspace.id} selectedSessionId="todo-geometry-session"
      capabilities={{ "desktop-work-state": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}}
      conversation={{ rows: [{ id: "reply", kind: "message", role: "assistant", text: "Synthetic conversation reply" }], canSend: false, running: false, pending: [],
        workState: { todos: todos ?? null, todosRevision: 0, goal: null }, onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
    const html = view.container.innerHTML
    view.unmount()
    return html
  } finally { useUiStore.setState(saved) }
}

beforeAll(async () => {
  if (!playwrightModule) return
  const { chromium } = await import(/* @vite-ignore */ pathToFileURL(playwrightModule).href) as {
    chromium: { launch(options: { executablePath?: string; headless: boolean }): Promise<GeometryBrowser> }
  }
  browser = await chromium.launch({ executablePath: browserExecutable, headless: true })
})
afterAll(async () => { await browser?.close() })

describe.skipIf(!playwrightModule)("Todo progress browser geometry", () => {
  it("floats above the conversation without changing transcript or composer geometry", async () => {
    const page = await browser!.newPage()
    const results = []
    // Include the screenshot's 1416 CSS px with a 48 px rail, then the requested
    // viewport sizes with the project pane expanded and the review pane open.
    const layouts = [
      { width: 1416, sidebarCollapsed: true, reviewOpen: false },
      { width: 1500, sidebarCollapsed: false, reviewOpen: false },
      { width: 1500, sidebarCollapsed: false, reviewOpen: true },
      { width: 1180, sidebarCollapsed: false, reviewOpen: false },
      { width: 1180, sidebarCollapsed: false, reviewOpen: true },
      { width: 680, sidebarCollapsed: false, reviewOpen: false },
      { width: 680, sidebarCollapsed: false, reviewOpen: true },
      { width: 2560, sidebarCollapsed: false, reviewOpen: false },
      { width: 2560, sidebarCollapsed: false, reviewOpen: true },
      { width: 320, sidebarCollapsed: true, reviewOpen: false },
    ]
    for (const layout of layouts) {
      await page.setViewportSize({ width: layout.width, height: 900 })
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${markup([], layout.sidebarCollapsed, layout.reviewOpen)}`)
      const withoutTodo = await page.evaluate(() => {
        const rect = (selector: string) => {
          const { left, top, right, bottom, width, height } = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
          return { left, top, right, bottom, width, height }
        }
        return { timeline: rect(".timeline-region"), composer: rect(".conversation-dock") }
      })
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${markup(seven, layout.sidebarCollapsed, layout.reviewOpen)}`)
      const geometry = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>(".todo-progress-host")!
        const todo = document.querySelector<HTMLElement>(".todo-progress-dock")!
        const timeline = document.querySelector<HTMLElement>(".timeline-region")!
        const composer = document.querySelector<HTMLElement>(".conversation-dock")!
        const list = document.querySelector<HTMLElement>(".todo-progress-list")!
        const rect = (element: HTMLElement) => {
          const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
          return { left, top, right, bottom, width, height }
        }
        const listRect = list.getBoundingClientRect()
        const glyphs = Array.from(list.children).flatMap((item) => {
          const range = document.createRange()
          range.selectNodeContents(item.lastElementChild!)
          return Array.from(range.getClientRects())
        })
        list.scrollLeft = 999
        list.scrollTop = list.scrollHeight
        const last = list.lastElementChild!.getBoundingClientRect()
        const todoRect = todo.getBoundingClientRect()
        const cardHit = document.elementFromPoint(todoRect.left + todoRect.width / 2, todoRect.top + 20)
        const outsideHit = document.elementFromPoint(Math.max(host.getBoundingClientRect().left + 1, todoRect.left - 10), todoRect.top + 20)
        return {
          host: rect(host), todo: rect(todo), timeline: rect(timeline), composer: rect(composer),
          list: { width: list.clientWidth, scrollWidth: list.scrollWidth, height: list.clientHeight, scrollHeight: list.scrollHeight, scrollLeft: list.scrollLeft },
          minIconLeft: Math.min(...Array.from(list.children).map((item) => item.firstElementChild!.getBoundingClientRect().left - listRect.left)),
          minGlyphLeft: Math.min(...glyphs.map((glyph) => glyph.left - listRect.left)),
          maxGlyphRight: Math.max(...glyphs.map((glyph) => glyph.right - listRect.left)),
          lastBottom: last.bottom, listBottom: listRect.bottom,
          actions: Array.from(todo.querySelectorAll<HTMLButtonElement>(".todo-progress-actions button")).map(rect),
          cardReceivesHit: cardHit !== null && todo.contains(cardHit),
          reviewReceivesHit: Boolean(cardHit?.closest(".review-pane")),
          outsideReceivesTodoHit: outsideHit !== null && todo.contains(outsideHit),
        }
      })
      results.push({ ...layout, ...geometry, withoutTodo })
      expect(geometry.todo.left, JSON.stringify(layout)).toBeGreaterThanOrEqual(geometry.host.left)
      expect(geometry.todo.right).toBeLessThanOrEqual(geometry.host.right)
      expect(geometry.todo.bottom).toBeLessThanOrEqual(geometry.host.bottom)
      expect(geometry.timeline.bottom).toBeLessThanOrEqual(geometry.composer.top + 1)
      expect(geometry.timeline, JSON.stringify(layout)).toEqual(withoutTodo.timeline)
      expect(geometry.composer).toEqual(withoutTodo.composer)
      expect(geometry.todo.width).toBeLessThanOrEqual(300)
      expect(geometry.todo.top - geometry.host.top).toBe(12)
      expect(geometry.outsideReceivesTodoHit).toBe(false)
      const reviewOverlaysConversation = layout.reviewOpen && layout.width < 1180
      expect(geometry.cardReceivesHit).toBe(!reviewOverlaysConversation)
      if (reviewOverlaysConversation) expect(geometry.reviewReceivesHit).toBe(true)
      expect(geometry.list.scrollWidth).toBe(geometry.list.width)
      expect(geometry.list.scrollLeft).toBe(0)
      expect(geometry.minIconLeft).toBeGreaterThanOrEqual(0)
      expect(geometry.minGlyphLeft).toBeGreaterThanOrEqual(20)
      expect(geometry.maxGlyphRight).toBeLessThanOrEqual(geometry.list.width + 1)
      expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.listBottom + 1)
      for (const action of geometry.actions) {
        expect(action.left).toBeGreaterThanOrEqual(geometry.todo.left)
        expect(action.right).toBeLessThanOrEqual(geometry.todo.right)
        expect(action.bottom).toBeLessThanOrEqual(geometry.todo.bottom)
      }
    }
    if (process.env.IH_TODO_LAYOUT_REPORT) writeFileSync(process.env.IH_TODO_LAYOUT_REPORT, JSON.stringify(results, null, 2))
  })

  it("keeps a tall Todo page scrollable without clipping its actions in a short conversation", async () => {
    const page = await browser!.newPage()
    const todos = Array.from({ length: 56 }, (_, index) => ({
      content: `工作 ${index + 1} 📂 ${"檢查長工具路徑/exec_command/read/write/apply_patch".repeat(4)}`,
      status: index < 53 ? "completed" as const : index === 53 ? "in_progress" as const : "pending" as const,
    }))
    for (const width of [680, 1500, 2560]) for (const height of [480, 300]) {
      await page.setViewportSize({ width, height })
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${markup(todos, false, false)}`)
      const geometry = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>(".todo-progress-host")!.getBoundingClientRect()
        const todo = document.querySelector<HTMLElement>(".todo-progress-dock")!.getBoundingClientRect()
        const list = document.querySelector<HTMLElement>(".todo-progress-list")!
        const pager = document.querySelector<HTMLElement>(".todo-progress-pager")!.getBoundingClientRect()
        list.scrollTop = list.scrollHeight
        return { hostBottom: host.bottom, todoBottom: todo.bottom, pagerBottom: pager.bottom,
          listBottom: list.getBoundingClientRect().bottom, lastBottom: list.lastElementChild!.getBoundingClientRect().bottom,
          listHeight: list.clientHeight, scrollHeight: list.scrollHeight, items: list.children.length,
          width: list.clientWidth, scrollWidth: list.scrollWidth }
      })
      expect(geometry.todoBottom).toBeLessThanOrEqual(geometry.hostBottom)
      expect(geometry.pagerBottom).toBeLessThanOrEqual(geometry.todoBottom)
      expect(geometry.listHeight).toBeGreaterThan(0)
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.listHeight)
      expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.listBottom + 1)
      expect(geometry.items).toBe(8)
      expect(geometry.scrollWidth).toBe(geometry.width)
    }
  })

  it("leaves the transcript's width and height available when the Todo snapshot is empty", async () => {
    const page = await browser!.newPage()
    await page.setViewportSize({ width: 1500, height: 900 })
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${markup([], false, false)}`)
    const geometry = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".todo-progress-host")!.getBoundingClientRect()
      const timeline = document.querySelector<HTMLElement>(".timeline-region")!.getBoundingClientRect()
      return { hostWidth: host.width, timelineWidth: timeline.width, timelineHeight: timeline.height,
        top: timeline.top - host.top, todoCount: document.querySelectorAll(".todo-progress-dock").length }
    })
    expect(geometry.todoCount).toBe(0)
    expect(geometry.top).toBe(0)
    expect(geometry.timelineWidth).toBeGreaterThanOrEqual(geometry.hostWidth - 40)
    expect(geometry.timelineHeight).toBeGreaterThan(500)
  })
})
