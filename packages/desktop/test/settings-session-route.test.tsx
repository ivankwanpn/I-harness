// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Workbench, type WorkbenchProps } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { DesktopBridge } from "../src/shared/bridge.ts"

afterEach(() => { cleanup(); localStorage.clear(); useUiStore.setState({ surface: "conversation", selectedWorkspaceId: undefined, selectedSessionId: undefined, locale: "zh-TW" }) })
const workspace = { id: "owned", label: "Owned fixture", path: "D:/I-harness-main/.tmp/settings-management" }
const rows = [{ id: "session", title: "Owned session", live: false }]
function base(bridge: DesktopBridge): WorkbenchProps {
  return { projects: [], bridge, workspaces: [workspace], selectedWorkspaceId: workspace.id, selectedSessionId: "session", dashboard: { sessions: rows }, capabilities: { "desktop-sessions": ["1"], "desktop-rewind": ["1"] }, onSelectWorkspace() {}, onSelectSession() {} }
}
function bridgeFor(): DesktopBridge {
  return { request: vi.fn(async request => {
    if (request.kind === "session/list") return { sessions: rows }
    if (request.kind === "desktop/session/archived") return [{ id: "archived", title: "Archived fixture" }]
    if (request.kind === "desktop/session/navigation/state") return { session: { projectId: "source", pinned: false, unread: false } }
    if (request.kind === "desktop/rewind/points") return [{ turnIndex: 0, preview: "Owned turn", files: 0 }]
    if (request.kind === "desktop/rewind/plan") return { fingerprint: "owned-plan", ops: [], conflicts: [], unTracked: [] }
    if (request.kind === "desktop/rewind/execute") return { revertedFiles: 0, errors: [], eventAppended: true }
    return []
  }), onEvent: () => () => {} }
}

it("retains scoped rewind through the existing conversation manager", async () => {
  const bridge = bridgeFor(), rewind = vi.fn()
  render(<Workbench {...base(bridge)} onManageSessionInWorkspace={async () => {}} onRewindComplete={rewind} onBatchSessions={async () => ({ results: [] })} />)
  fireEvent.click(screen.getByRole("button", { name: "批次管理會話" }))
  const manager = await screen.findByRole("dialog", { name: "管理會話" })
  fireEvent.click(await within(manager).findByRole("button", { name: "回復會話" }))
  fireEvent.change(await within(manager).findByLabelText("回復點"), { target: { value: "0" } })
  fireEvent.click(within(manager).getByRole("button", { name: "預覽回復" }))
  fireEvent.click(await within(manager).findByRole("checkbox", { name: "我已查看影響範圍並確認回復" }))
  fireEvent.click(within(manager).getByRole("button", { name: "確認回復" }))
  await waitFor(() => expect(rewind).toHaveBeenCalledWith("owned", "session"))
  expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/rewind/execute", workspaceId: "owned", sessionId: "session", target: 0, mode: "all", fingerprint: "owned-plan" })
})

it("retains active and archived management when only the selected workspace callback exists", async () => {
  const bridge = bridgeFor(), manage = vi.fn(async () => {})
  render(<Workbench {...base(bridge)} onManageSession={manage} onBatchSessions={async () => ({ results: [] })} />)
  fireEvent.click(screen.getByRole("button", { name: "管理已封存會話" }))
  const manager = await screen.findByRole("dialog", { name: "管理會話" })
  fireEvent.click(await within(manager).findByRole("button", { name: "還原會話" }))
  await waitFor(() => expect(manage).toHaveBeenCalledWith("archived", "restore", undefined))
  fireEvent.click(within(manager).getByRole("button", { name: "目前會話" }))
  fireEvent.click(await within(manager).findByRole("button", { name: "建立分支" }))
  await waitFor(() => expect(manage).toHaveBeenCalledWith("session", "fork", undefined))
  expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/session/archived", workspaceId: "owned" })
  expect(bridge.request).toHaveBeenCalledWith({ kind: "session/list", workspaceId: "owned" })
})

it("keeps project moves and batch actions discoverable in the existing manager", async () => {
  const bridge = bridgeFor(), batch = vi.fn(async (_workspace: string, command: { sessionIds: string[] }) => ({ results: command.sessionIds.map(sessionId => ({ sessionId, ok: true as const })) }))
  render(<Workbench {...base(bridge)} projects={[{ id: "source", name: "Source", workspaceIds: ["owned"], createdAt: "2026-10-09", updatedAt: "2026-10-09" }, { id: "destination", name: "Destination", workspaceIds: [], createdAt: "2026-10-09", updatedAt: "2026-10-09" }]} selectedProjectId="source" onManageSessionInWorkspace={async () => {}} onBatchSessions={batch} />)
  fireEvent.click(await screen.findByRole("button", { name: "批次管理會話" }))
  const manager = await screen.findByRole("dialog", { name: "管理會話" })
  fireEvent.click(await within(manager).findByRole("checkbox", { name: "選取 Owned session" }))
  expect(within(manager).getByRole("button", { name: "封存所選會話" })).toBeTruthy()
  expect(within(manager).getByRole("button", { name: "永久刪除所選會話" })).toBeTruthy()
  fireEvent.change(await within(manager).findByRole("combobox", { name: "目的專案" }), { target: { value: "destination" } })
  fireEvent.click(within(manager).getByRole("button", { name: "移動所選會話" }))
  expect(batch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "確認移動" }))
  await waitFor(() => expect(batch).toHaveBeenCalledWith("owned", { action: "move", sessionIds: ["session"], projectId: "destination", expectedOwners: { session: "source" } }))
})
