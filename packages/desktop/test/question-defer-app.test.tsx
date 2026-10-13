// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "../src/shared/bridge.ts"
import type { PendingInteraction } from "../src/renderer/interaction/pending.ts"
import type { WorkbenchProps } from "../src/renderer/shell/Workbench.tsx"
import { PendingPanel } from "../src/renderer/interaction/PendingPanel.tsx"
// Keep App's real interaction state, callbacks and question controls. The shell's
// unrelated project/review panels are outside this interaction integration.
vi.mock("../src/renderer/shell/Workbench.tsx", () => ({ Workbench: (props: WorkbenchProps) => <>
  <button disabled={!props.selectedWorkspaceId} onClick={() => props.onSelectSession("s1")}>Open question session</button>
  <button onClick={props.onRetry}>Refresh connection</button>
  {props.conversation && <PendingPanel draftOwner={props.bridge} workspaceId={props.selectedWorkspaceId}
    pending={props.conversation.pending} onReply={props.conversation.onReply} />}
</> }))
import { App } from "../src/renderer/app.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(() => { cleanup(); useUiStore.setState({ selectedWorkspaceId: undefined, selectedSessionId: undefined, locale: "zh-TW", surface: "conversation" }) })

it.each([false, true])("keeps deferred cards after acknowledgement (cancel before acknowledgement: %s)", async cancel => {
  const listeners = new Set<(event: DesktopEvent) => void>()
  const emit = (method: "desktop/interaction/request" | "desktop/interaction/closed", params: unknown) => {
    for (const listener of listeners) listener({ kind: "sdk/notification", workspaceId: "w1", method, params })
  }
  const original: PendingInteraction = { requestId: "q1", sessionId: "s1", kind: "question", openedAt: 1,
    payload: { prompt: "Which plan?", options: ["A", "B"] } }
  let rows = [original]
  let release!: () => void
  const acknowledgement = new Promise<void>(resolve => { release = resolve })
  const decisions: unknown[] = []
  let reads = 0
  const bridge: DesktopBridge = {
    onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    request: async (request: DesktopRequest) => {
      switch (request.kind) {
        case "workspace/list": return [{ id: "w1", path: "D:/fixture", label: "fixture" }]
        case "session/dashboard": return { sessions: [{ id: "s1", live: true }] }
        case "desktop/capabilities": return {}
        case "workspace/sandbox/state": return { mode: "read-only", source: "settings", wired: true }
        case "session/history": return { events: [], nextSeq: 0 }
        case "session/model/state": return { status: "unconfigured", reason: "test" }
        case "desktop/review/changes": return { kind: "ok", files: [], truncated: false }
        case "desktop/interaction/pending": reads++; return structuredClone(rows)
        case "desktop/interaction/reply":
          decisions.push(request.decision)
          if ("deferred" in request.decision) {
            rows = [{ ...original, state: "interrupted" }]
            emit("desktop/interaction/request", rows[0])
            await acknowledgement
          } else {
            rows = []
            emit("desktop/interaction/closed", { requestId: "q1", sessionId: "s1", reason: "reply" })
          }
          return { accepted: true }
        default: return []
      }
    },
  }
  render(<App bridge={bridge} />)
  await waitFor(() => expect((screen.getByText("Open question session") as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByText("Open question session"))
  const defer = await screen.findByRole("button", { name: "保留問題，稍後回答 Which plan?" })
  fireEvent.click(defer)
  fireEvent.click(defer)
  expect(decisions).toEqual([{ kind: "question", deferred: true }])
  if (cancel) {
    rows = []
    act(() => emit("desktop/interaction/closed", { requestId: "q1", sessionId: "s1", reason: "cancelled" }))
  }
  await act(async () => { release(); await acknowledgement })
  if (cancel) {
    expect(screen.queryByRole("textbox", { name: "回答 Which plan?" })).toBeNull()
    return
  }
  expect(screen.getByRole("button", { name: "儲存回答" })).toBeTruthy()
  const before = reads
  fireEvent.click(screen.getByText("Refresh connection"))
  await waitFor(() => expect(reads).toBeGreaterThan(before))
  const answer = screen.getByRole("textbox", { name: "回答 Which plan?" }) as HTMLTextAreaElement
  fireEvent.click(screen.getByRole("radio", { name: "A" }))
  fireEvent.change(answer, { target: { value: "My own approach" } })
  expect((screen.getByRole("radio", { name: "A" }) as HTMLInputElement).checked).toBe(false)
  fireEvent.click(screen.getByRole("radio", { name: "B" }))
  expect(answer.value).toBe("")
  fireEvent.change(answer, { target: { value: "Final free answer" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存回答" }))
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "回答 Which plan?" })).toBeNull())
  expect(decisions).toEqual([{ kind: "question", deferred: true }, { kind: "question", answer: "Final free answer" }])
})
