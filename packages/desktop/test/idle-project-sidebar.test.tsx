// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopEvent } from "../src/shared/bridge.ts"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import { WindowVisibilityProvider } from "../src/renderer/window-visibility.tsx"
import { projectHistoryTimeline, type WireEvent } from "../src/renderer/session/project.ts"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useUiStore.setState({ sidebarCollapsed: false, surface: "conversation" })
})

it("defers hidden project reads and refreshes only changed folders after a tray reconnect", async () => {
  vi.useFakeTimers()
  useUiStore.setState({ sidebarCollapsed: true, surface: "conversation" })
  const workspaces = Array.from({ length: 24 }, (_, index) => ({
    id: "w" + index, path: "D:/test/" + index, label: "Folder " + index,
  }))
  const projects = workspaces.map((folder, index) => ({
    id: "p" + index, name: "Project " + index, workspaceIds: [folder.id],
    createdAt: "2026-11-01", updatedAt: "2026-11-01",
  }))
  const sessions = Array.from({ length: 120 }, (_, index) => ({
    id: "s" + index, title: "Historical conversation " + index, live: false,
  }))
  const recentEvents: WireEvent[] = Array.from({ length: 2500 }, (_, index) => [
    { type: "user/message" as const, seq: index * 2, text: "Question " + index },
    { type: "assistant/message" as const, seq: index * 2 + 1, text: "Response " + index },
  ]).flat()
  const listeners = new Set<(event: DesktopEvent) => void>()
  const reads: string[] = []
  const bridge: DesktopBridge = {
    async request(value) {
      if (value.kind === "window/state") return { visible: true }
      if (value.kind === "session/dashboard") {
        reads.push(value.workspaceId + "/dashboard")
        return { sessions }
      }
      if (value.kind === "desktop/session/navigation/state") {
        reads.push(value.workspaceId + "/navigation")
        const projectId = "p" + value.workspaceId.slice(1)
        const entries = Object.fromEntries(sessions.map(session => [session.id, { pinned: false, unread: false, projectId }]))
        return { partial: false, entries }
      }
      return undefined
    },
    onEvent(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
  const send = (event: DesktopEvent) => { for (const listener of listeners) listener(event) }
  const advance = (ms = 600) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  const tree = render(<WindowVisibilityProvider bridge={bridge}>
    <Workbench bridge={bridge} projects={projects} workspaces={workspaces} capabilities={{}}
      selectedProjectId="p0" selectedWorkspaceId="w0" selectedSessionId="s0" dashboard={{ sessions }}
      conversation={{
        rows: projectHistoryTimeline(recentEvents), recentEvents, canSend: false, running: false, pending: [],
        onPrompt: async () => {}, onCancel: async () => {}, onCancelTask: () => {}, onCancelQueue: () => {}, onReply: async () => {},
      }}
      onSelectWorkspace={() => {}} onSelectSession={() => {}} />
  </WindowVisibilityProvider>)

  await advance()
  expect(reads).toEqual([])
  act(() => useUiStore.setState({ sidebarCollapsed: false }))
  await advance()
  expect(reads.filter(read => read.endsWith("/navigation")).sort()).toEqual(workspaces.map(folder => folder.id + "/navigation").sort())
  reads.length = 0

  await advance(120_000)
  expect(reads).toEqual([])
  act(() => send({ kind: "window/state", maximized: false, visible: false }))
  act(() => {
    for (let change = 0; change < 5; change++) {
      send({ kind: "sdk/notification", workspaceId: "w7", method: "desktop/session/navigation/changed", params: {} })
    }
    send({ kind: "sdk/disconnected", workspaceId: "w7", message: "offline" })
    send({ kind: "sdk/ready", workspaceId: "w7", method: "sdk/ready", runtimeGeneration: 2 })
  })
  await advance()
  expect(reads).toEqual([])
  act(() => send({ kind: "window/state", maximized: false, visible: true }))
  await advance()
  expect(reads).toEqual(["w7/navigation"])

  tree.unmount()
  expect(listeners.size).toBe(0)
})
