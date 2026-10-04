// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it } from "vitest"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ surface: "conversation", sidebarCollapsed: false, reviewOpen: true })
  useUiStore.getState().reset()
})
afterEach(() => { cleanup(); useUiStore.setState({ reviewOpen: false }); localStorage.clear() })

function mount() {
  return render(<Workbench bridge={{ request: async () => undefined, onEvent: () => () => {} }} workspaces={[]} capabilities={{}} onSelectWorkspace={() => {}} onSelectSession={() => {}} />)
}

it("resizes both real panes independently and retains widths when reopened", () => {
  mount()
  const left = screen.getByRole("separator", { name: "調整側欄寬度" })
  const right = screen.getByRole("separator", { name: "調整成果面板寬度" })
  fireEvent.keyDown(left, { key: "ArrowRight" })
  fireEvent.keyDown(right, { key: "ArrowLeft" })
  expect(left.getAttribute("aria-valuenow")).toBe("260")
  expect(right.getAttribute("aria-valuenow")).toBe("380")
  expect(JSON.parse(localStorage.getItem("ih:ui-preferences")!)).toMatchObject({ sidebarWidth: 260, reviewWidth: 380 })
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  fireEvent.click(screen.getByRole("button", { name: "關閉成果面板" }))
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  fireEvent.click(screen.getByRole("button", { name: "成果檢查" }))
  expect(screen.getByRole("separator", { name: "調整側欄寬度" }).getAttribute("aria-valuenow")).toBe("260")
  expect(screen.getByRole("separator", { name: "調整成果面板寬度" }).getAttribute("aria-valuenow")).toBe("380")
})

it("restores the two defaults without resetting the selected conversation or the other pane", () => {
  mount()
  act(() => useUiStore.setState({ selectedWorkspaceId: "owned", selectedSessionId: "retained" }))
  const left = screen.getByRole("separator", { name: "調整側欄寬度" })
  const right = screen.getByRole("separator", { name: "調整成果面板寬度" })
  fireEvent.keyDown(left, { key: "ArrowRight" })
  fireEvent.keyDown(right, { key: "ArrowLeft" })
  fireEvent.doubleClick(left)
  expect(left.getAttribute("aria-valuenow")).toBe("240")
  expect(right.getAttribute("aria-valuenow")).toBe("380")
  fireEvent.doubleClick(right)
  expect(right.getAttribute("aria-valuenow")).toBe("360")
  expect(useUiStore.getState()).toMatchObject({ selectedWorkspaceId: "owned", selectedSessionId: "retained" })
})
