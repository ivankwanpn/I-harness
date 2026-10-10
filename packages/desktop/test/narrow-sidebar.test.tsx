// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
const original = window.matchMedia
afterEach(() => { cleanup(); window.matchMedia = original; useUiStore.setState({ surface: "conversation", sidebarCollapsed: false }) })
it("opens a narrow drawer and restores focus on Escape without altering desktop preferences", () => {
  window.matchMedia = vi.fn((query) => ({ matches: query.includes("759px"), addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
  render(<Workbench bridge={{ request: async () => undefined, onEvent: () => () => {} }} workspaces={[]} capabilities={{}} onSelectSession={() => {}} onSelectWorkspace={() => {}} />)
  expect(screen.queryByRole("navigation", { name: "首頁" })).toBeNull()
  const toggle = screen.getByRole("button", { name: "顯示側欄" })
  toggle.focus(); fireEvent.click(toggle)
  expect(screen.getByRole("dialog", { name: "專案" })).toBeTruthy()
  expect(document.activeElement?.textContent).toBe("關閉側欄")
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog", { name: "專案" })).toBeNull()
  expect(document.activeElement).toBe(toggle)
})

it("closes the Home drawer when entering standalone project management without picking a folder", () => {
  window.matchMedia = vi.fn((query) => ({ matches: query.includes("759px"), addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
  const request = vi.fn(async (_input: { kind: string }) => undefined)
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[]} projects={[]} capabilities={{}} onProjectsChanged={async () => {}} onSelectSession={() => {}} onSelectWorkspace={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  fireEvent.click(within(screen.getByRole("dialog", { name: "專案" })).getByRole("button", { name: "管理專案" }))
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.getByRole("region", { name: "專案" })).toBeTruthy()
  expect(request.mock.calls.some(([input]) => (input as { kind: string }).kind === "workspace/pick")).toBe(false)
})

it("leaves Escape and Tab to a foreground session menu, then closes the drawer on the next Escape", async () => {
  window.matchMedia = vi.fn((query) => ({ matches: query.includes("759px"), addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
  render(<Workbench bridge={{ request: async input => input.kind === "desktop/session/navigation/state" ? { owned: { pinned: false, unread: false, projectId: "owned-p" } } : { sessions: [{ id: "owned", title: "Owned", live: false }] }, onEvent: () => () => {} }} projects={[{ id: "owned-p", name: "Owned project", workspaceIds: ["owned-w"], createdAt: "2026-10-10", updatedAt: "2026-10-10" }]} selectedProjectId="owned-p" onProjectsChanged={async () => {}} workspaces={[{ id: "owned-w", label: "Owned workspace", path: "D:/owned" }]} selectedWorkspaceId="owned-w" dashboard={{ sessions: [{ id: "owned", title: "Owned", live: false }] }} capabilities={{}} onSelectSession={() => {}} onSelectWorkspace={() => {}} onManageSession={async () => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  fireEvent.click(within(screen.getByRole("navigation", { name: "主導覽" })).getByRole("button", { name: "專案" }))
  fireEvent.click(within(screen.getByRole("region", { name: "專案" })).getByText("Owned project").closest("button")!)
  fireEvent.click(await screen.findByRole("button", { name: "更多會話操作 Owned" }))
  const menu = screen.getByRole("menu", { name: "會話操作" })
  within(screen.getByRole("dialog", { name: "專案" })).getByRole("button", { name: "關閉側欄" }).focus()
  const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
  fireEvent(document, tab)
  expect(tab.defaultPrevented).toBe(false)
  const first = within(menu).getAllByRole("menuitem")[0]!
  first.focus()
  fireEvent.keyDown(first, { key: "Escape" })
  expect(screen.queryByRole("menu")).toBeNull()
  expect(screen.getByRole("dialog", { name: "專案" })).toBeTruthy()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog", { name: "專案" })).toBeNull()
})

it("keeps the drawer open for composition Escape and its late closing key", () => {
  window.matchMedia = vi.fn((query) => ({ matches: query.includes("759px"), addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
  render(<Workbench bridge={{ request: async () => undefined, onEvent: () => () => {} }} workspaces={[]} capabilities={{}} onSelectSession={() => {}} onSelectWorkspace={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  const drawer = screen.getByRole("dialog", { name: "專案" })
  fireEvent.compositionStart(drawer); fireEvent.keyDown(drawer, { key: "Escape", isComposing: true })
  fireEvent.compositionEnd(drawer); fireEvent.keyDown(drawer, { key: "Escape" })
  expect(screen.getByRole("dialog", { name: "專案" })).toBe(drawer)
  fireEvent.keyUp(drawer, { key: "Escape" }); fireEvent.keyDown(drawer, { key: "Escape" })
  expect(screen.queryByRole("dialog", { name: "專案" })).toBeNull()
})

it.each([false, true])("wraps Tab at the drawer boundary including held-key repeat=%s", repeat => {
  window.matchMedia = vi.fn((query) => ({ matches: query.includes("759px"), addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
  render(<Workbench bridge={{ request: async () => undefined, onEvent: () => () => {} }} workspaces={[]} capabilities={{}} onSelectSession={() => {}} onSelectWorkspace={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  const drawer = screen.getByRole("dialog", { name: "專案" })
  const boundary = within(drawer).getAllByRole("button").at(-1)!
  boundary.focus()
  const event = new KeyboardEvent("keydown", { key: "Tab", repeat, bubbles: true, cancelable: true })
  fireEvent(boundary, event)
  expect(event.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(within(drawer).getByRole("button", { name: "關閉側欄" }))
})
