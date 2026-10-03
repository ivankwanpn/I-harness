// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(() => { cleanup(); localStorage.clear(); useUiStore.setState({ surface: "conversation", reviewOpen: false, locale: "zh-TW" }) })
function fixture() {
  const request = vi.fn(async (input: any) => input.kind === "desktop/session/workflow/read" ? { goal: null, plan: { active: false }, team: { enabled: true, members: [], tasks: [] }, jobs: [], reviews: [] } : input.kind === "desktop/plugins/commands" ? [] : undefined)
  const props = { bridge: { request, onEvent: () => () => {} }, workspaces: [{ id: "workflow", label: "Fixture", path: "D:/fixture" }], selectedWorkspaceId: "workflow", selectedSessionId: "parent",
    onSelectWorkspace() {}, onSelectSession() {}, conversation: { rows: [], canSend: true, running: false, pending: [], onPrompt: vi.fn(async () => {}), onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} } }
  return { request, props }
}

it("keeps settings available in slash commands without offering unsupported workflow routes or requesting their backend", async () => {
  const { request, props } = fixture()
  render(<Workbench {...props} capabilities={{}} />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "/" } })
  await screen.findByRole("option", { name: /\/settings/ })
  for (const name of ["goal", "team", "jobs", "reviews"]) expect(screen.queryByRole("option", { name: new RegExp(`/${name}`) })).toBeNull()
  expect(request.mock.calls.some(([input]) => input.kind.startsWith("desktop/session/workflow/"))).toBe(false)
  fireEvent.click(screen.getByRole("option", { name: /\/settings/ }))
  expect(screen.getByRole("region", { name: "設定" })).toBeTruthy()
  expect(request.mock.calls.some(([input]) => input.kind.startsWith("desktop/session/workflow/"))).toBe(false)
})

it("unmounts an open workflow when capability disappears and retains an unavailable explanation", async () => {
  const { request, props } = fixture()
  const view = render(<Workbench {...props} capabilities={{ "desktop-workflow": ["1"] }} />)
  fireEvent.click(screen.getByRole("button", { name: "Goal / Plan" }))
  await screen.findByRole("textbox", { name: "目標內容" })
  const calls = request.mock.calls.filter(([input]) => input.kind.startsWith("desktop/session/workflow/")).length
  view.rerender(<Workbench {...props} capabilities={{}} />)
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "目標內容" })).toBeNull())
  expect(screen.getByRole("status").textContent).toContain("目前工作區後端未提供此功能。")
  expect(screen.queryByRole("tab", { name: "工作流程" })).toBeNull()
  expect(request.mock.calls.filter(([input]) => input.kind.startsWith("desktop/session/workflow/"))).toHaveLength(calls)
})
