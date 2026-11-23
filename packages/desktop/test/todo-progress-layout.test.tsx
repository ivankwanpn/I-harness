// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { render } from "@testing-library/react"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { DesktopBridge } from "../src/shared/bridge.ts"

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
  .map(path => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer", path), "utf8"))
  .join("\n")
const workspace = { id: "todo-geometry", path: "D:/synthetic-todo-geometry", label: "Todo geometry" }
const bridge: DesktopBridge = { request: async () => undefined, onEvent: () => () => {} }

function markup(complete: boolean, sidebarCollapsed: boolean, reviewOpen: boolean) {
  const saved = useUiStore.getState()
  useUiStore.setState({ sidebarCollapsed, reviewOpen, surface: "conversation" })
  try {
    const view = render(<Workbench bridge={bridge} projects={[]} workspaces={[workspace]} selectedWorkspaceId={workspace.id} selectedSessionId="todo-geometry-session"
      capabilities={{ "desktop-work-state": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}}
      conversation={{ rows: [{ id: "reply", kind: "message", role: "assistant", text: "Existing reply" }], canSend: false, running: false, pending: [],
        workState: { todos: [{ content: `檢查 ${"long_file_name_".repeat(50)}`, status: complete ? "completed" : "in_progress" }], todosRevision: 0, goal: null },
        onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
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

describe.skipIf(!playwrightModule)("Todo summary browser geometry", () => {
  it("fits a long active item above the composer and keeps the editor anchored when the summary clears", async () => {
    const page = await browser!.newPage()
    for (const layout of [
      { width: 640, height: 480, sidebarCollapsed: true, reviewOpen: false },
      { width: 1180, height: 800, sidebarCollapsed: false, reviewOpen: true },
      { width: 1920, height: 1080, sidebarCollapsed: false, reviewOpen: true },
    ]) {
      await page.setViewportSize({ width: layout.width, height: layout.height })
      const read = async (complete: boolean) => {
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${markup(complete, layout.sidebarCollapsed, layout.reviewOpen)}`)
        return page.evaluate(() => {
          const summarize = (selector: string) => {
            const el = document.querySelector(selector)
            return el?.getBoundingClientRect().toJSON() as DOMRect | undefined
          }
          return { composer: summarize(".composer-input")!, transcript: summarize(".timeline")!, dock: summarize(".conversation-dock")!, summary: summarize(".todo-progress-summary") }
        })
      }
      const active = await read(false)
      const completed = await read(true)
      expect(active.summary).toBeDefined()
      expect(active.summary!.left).toBeGreaterThanOrEqual(active.dock.left)
      expect(active.summary!.right).toBeLessThanOrEqual(active.dock.right)
      expect(active.summary!.top).toBeGreaterThanOrEqual(active.transcript.bottom)
      expect(active.summary!.bottom).toBeLessThan(active.composer.top)
      expect(active.summary!.height).toBeLessThan(40)
      expect(completed.summary).toBeUndefined()
      expect(completed.composer).toEqual(active.composer)
    }
  })
})
