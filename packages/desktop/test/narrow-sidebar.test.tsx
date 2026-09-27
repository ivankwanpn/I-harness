// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
const original = window.matchMedia
afterEach(() => { cleanup(); window.matchMedia = original })
it("opens a narrow drawer and restores focus on Escape without altering desktop preferences", () => {
  window.matchMedia = vi.fn((query) => ({ matches: query.includes("759px"), addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
  render(<Workbench bridge={{ request: async () => undefined, onEvent: () => () => {} }} workspaces={[]} capabilities={{}} onSelectSession={() => {}} onSelectWorkspace={() => {}} />)
  expect(screen.queryByRole("navigation", { name: "工作區" })).toBeNull()
  const toggle = screen.getByRole("button", { name: "顯示側欄" })
  toggle.focus(); fireEvent.click(toggle)
  expect(screen.getByRole("dialog", { name: "工作區" })).toBeTruthy()
  expect(document.activeElement?.textContent).toBe("關閉側欄")
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog", { name: "工作區" })).toBeNull()
  expect(document.activeElement).toBe(toggle)
})

it("closes the narrow drawer after opening a new workspace", () => {
  window.matchMedia = vi.fn((query) => ({ matches: query.includes("759px"), addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
  const bridge = { request: async () => undefined, onEvent: () => () => {} }
  const onOpenWorkspace = vi.fn()
  const props = { bridge, capabilities: {}, onSelectSession: () => {}, onSelectWorkspace: () => {}, onOpenWorkspace }
  const view = render(<Workbench {...props} workspaces={[]} />)
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  fireEvent.click(screen.getByRole("button", { name: "開啟工作區" }))
  expect(onOpenWorkspace).toHaveBeenCalledOnce()
  expect(screen.getByRole("dialog", { name: "工作區" })).toBeTruthy()
  view.rerender(<Workbench {...props} workspaces={[{ id: "w1", path: "D:/agent-complete/playground", label: "playground" }]} selectedWorkspaceId="w1" />)
  expect(screen.queryByRole("dialog", { name: "工作區" })).toBeNull()
})
