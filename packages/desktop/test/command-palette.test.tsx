// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { CommandPalette, type CommandPaletteProps } from "../src/renderer/shell/CommandPalette.tsx"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"

afterEach(cleanup)

function fixture(overrides: Partial<CommandPaletteProps> = {}) {
  const props = {
    bridge: { request: vi.fn(async () => ({})), onEvent: () => () => {} },
    commands: [{ id: "git", label: "專案 Git", run: vi.fn() }],
    workspace: { id: "local", label: "開發專案" },
    sessions: [{ id: "a", title: "會話整理" }],
    sessionSearch: true,
    onConversation: vi.fn(), onHistory: vi.fn(), onFile: vi.fn(), onClose: vi.fn(), ...overrides,
  } satisfies CommandPaletteProps
  render(<CommandPalette {...props} />)
  return { props, input: screen.getByRole("combobox", { name: "命令中心" }) }
}

it("executes commands and selects a titled conversation using the keyboard", () => {
  const { props, input } = fixture()
  expect(document.activeElement).toBe(input)
  fireEvent.change(input, { target: { value: "Git" } })
  fireEvent.keyDown(input, { key: "Enter", isComposing: true })
  expect(props.commands[0]!.run).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: "Enter" })
  expect(props.commands[0]!.run).toHaveBeenCalledOnce()
  fireEvent.change(input, { target: { value: "整理" } })
  fireEvent.keyDown(input, { key: "Enter" })
  expect(props.onConversation).toHaveBeenCalledWith("a")
})

it("opens a filename in the root returned by the active project selector", async () => {
  const request = vi.fn<NonNullable<CommandPaletteProps["files"]>["request"]>()
    .mockResolvedValueOnce({ roots: [{ workspaceId: "worktree", label: "isolated" }] })
    .mockResolvedValueOnce({ entries: [{ kind: "file", name: "src.ts", path: "src.ts" }], nextOffset: null, truncated: false })
  const { props, input } = fixture({ files: { selection: { workspaceId: "local", sessionId: "session", projectId: "project" }, request } })
  fireEvent.change(input, { target: { value: "@src" } })
  await screen.findByRole("option", { name: /src\.ts.*isolated/ })
  expect(request).toHaveBeenLastCalledWith({
    kind: "desktop/project-files/search", workspaceId: "local", projectId: "project", sessionId: "session",
    query: "src", ref: { workspaceId: "worktree", path: "" }, offset: 0,
  })
  fireEvent.keyDown(input, { key: "Enter" })
  expect(props.onFile).toHaveBeenCalledWith({ workspaceId: "worktree", path: "src.ts" })
})

it("keeps current history results when a prior query resolves late", async () => {
  const old = Promise.withResolvers<unknown>()
  const request = vi.fn<CommandPaletteProps["bridge"]["request"]>()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ hits: [{ sessionId: "a", seq: 21, snippet: "新內容" }] })
  const { props, input } = fixture({ bridge: { request, onEvent: () => () => {} } })
  fireEvent.change(input, { target: { value: "#old" } })
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  fireEvent.change(input, { target: { value: "#new" } })
  await screen.findByText("新內容")
  await act(async () => old.resolve({ hits: [{ sessionId: "a", seq: 0, snippet: "過期內容" }] }))
  expect(screen.queryByText("過期內容")).toBeNull()
  fireEvent.keyDown(input, { key: "Enter" })
  expect(props.onHistory).toHaveBeenCalledWith({ workspaceId: "local", sessionId: "a", seq: 21 })
})

it("restores the previously focused control when Esc closes the workbench command center", () => {
  render(<Workbench bridge={{ request: async () => ({}), onEvent: () => () => {} }}
    workspaces={[]} capabilities={{}} onSelectWorkspace={() => {}} onSelectSession={() => {}} />)
  const trigger = screen.getByRole("button", { name: "命令中心" })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "k", ctrlKey: true })
  const input = screen.getByRole("combobox", { name: "命令中心" })
  expect(document.activeElement).toBe(input)
  fireEvent.keyDown(input, { key: "Escape" })
  expect(screen.queryByRole("dialog", { name: "命令中心" })).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
