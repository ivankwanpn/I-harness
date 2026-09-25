import { useCallback, useEffect, useState } from "react"
import type {
  AgentTaskView,
  HistoryRange,
  SessionDashboardResult,
  SessionModelState,
  SessionQueueItem,
} from "@i-harness/sdk"
import type { SandboxState } from "../main/sdk-runtime.ts"
import type { WorkspaceEntry } from "../main/workspaces.ts"
import type { DesktopBridge } from "../shared/bridge.ts"
import { applyHistory, applyNotification, emptyEventWindow, type EventWindow, type WireEvent } from "./session/event-window.ts"
import { projectTimeline } from "./session/project.ts"
import { sendGate } from "./session/send-gate.ts"
import { Workbench } from "./shell/Workbench.tsx"

const HISTORY_LIMIT = 500

/** The renderer data layer: it owns the bridge, selection and refresh rules;
 * the workbench below renders exactly what it is told. */
export function App({ bridge }: { bridge: DesktopBridge }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>()
  const [selectedSessionId, setSelectedSessionId] = useState<string>()
  const [dashboard, setDashboard] = useState<SessionDashboardResult>()
  const [capabilities, setCapabilities] = useState<Record<string, string[]>>({})
  const [sandbox, setSandbox] = useState<SandboxState>()
  const [error, setError] = useState<string>()
  const [eventWindow, setEventWindow] = useState<EventWindow>(() => emptyEventWindow())
  const [model, setModel] = useState<SessionModelState>()
  const [queue, setQueue] = useState<SessionQueueItem[]>()
  const [tasks, setTasks] = useState<AgentTaskView[]>()
  const [taskError, setTaskError] = useState<string>()
  const [running, setRunning] = useState(false)
  const [sending, setSending] = useState(false)

  const refreshDashboard = useCallback(async (workspaceId: string): Promise<void> => {
    const result = await bridge.request({ kind: "session/dashboard", workspaceId })
    setDashboard(result as SessionDashboardResult)
  }, [bridge])

  const refreshTasks = useCallback(async (workspaceId: string, sessionId: string): Promise<void> => {
    try {
      const [queueRows, taskRows] = await Promise.all([
        bridge.request({ kind: "session/queue", workspaceId, sessionId }),
        bridge.request({ kind: "session/tasks", workspaceId, sessionId }),
      ])
      setQueue(queueRows as SessionQueueItem[])
      setTasks(taskRows as AgentTaskView[])
      setTaskError(undefined)
    } catch (reason) {
      setTaskError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [bridge])

  const refreshHistory = useCallback(async (workspaceId: string, sessionId: string): Promise<void> => {
    const page = await bridge.request({
      kind: "session/history", workspaceId, sessionId, afterSeq: 0, limit: HISTORY_LIMIT,
    })
    // Re-reading the bounded window is idempotent: events merge by seq.
    setEventWindow((current) => applyHistory(current, page as HistoryRange))
  }, [bridge])

  useEffect(() => {
    let active = true
    void bridge.request({ kind: "workspace/list" })
      .then((rows) => {
        if (!active) return
        const list = rows as WorkspaceEntry[]
        setWorkspaces(list)
        setSelectedWorkspaceId((current) => current ?? list[0]?.id)
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { active = false }
  }, [bridge])

  useEffect(() => {
    if (selectedWorkspaceId === undefined) return
    let active = true
    void (async () => {
      try {
        const [dashboardResult, capabilitiesResult, sandboxResult] = await Promise.all([
          bridge.request({ kind: "session/dashboard", workspaceId: selectedWorkspaceId }),
          bridge.request({ kind: "desktop/capabilities", workspaceId: selectedWorkspaceId }),
          bridge.request({ kind: "workspace/sandbox/state", workspaceId: selectedWorkspaceId }),
        ])
        if (!active) return
        setDashboard(dashboardResult as SessionDashboardResult)
        setCapabilities((capabilitiesResult ?? {}) as Record<string, string[]>)
        setSandbox(sandboxResult as SandboxState | undefined)
        setError(undefined)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => { active = false }
  }, [bridge, selectedWorkspaceId])

  useEffect(() => {
    if (selectedWorkspaceId === undefined || selectedSessionId === undefined) return
    let active = true
    setEventWindow(emptyEventWindow())
    setModel(undefined)
    setQueue(undefined)
    setTasks(undefined)
    setTaskError(undefined)
    setRunning(false)
    void (async () => {
      try {
        const [page, modelState] = await Promise.all([
          bridge.request({
            kind: "session/history", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, afterSeq: 0, limit: HISTORY_LIMIT,
          }),
          bridge.request({ kind: "session/model/state", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }),
        ])
        if (!active) return
        setEventWindow(applyHistory(emptyEventWindow(), page as HistoryRange))
        setModel(modelState as SessionModelState)
      } catch (reason) {
        if (active) setTaskError(reason instanceof Error ? reason.message : String(reason))
      }
      if (!active) return
      await refreshTasks(selectedWorkspaceId, selectedSessionId)
    })()
    return () => { active = false }
  }, [bridge, refreshTasks, selectedSessionId, selectedWorkspaceId])

  useEffect(() => {
    if (selectedWorkspaceId === undefined) return
    return bridge.onEvent((event) => {
      if (event.kind !== "sdk/notification" || event.workspaceId !== selectedWorkspaceId) return
      void refreshDashboard(event.workspaceId)
      if (selectedSessionId === undefined) return
      const params = (event.params ?? {}) as { sessionId?: unknown; event?: unknown; status?: unknown }
      if (params.sessionId !== selectedSessionId) return
      if (event.method === "session/event" && params.event !== undefined) {
        const wireEvent = params.event as WireEvent
        setEventWindow((current) => applyNotification(current, wireEvent))
        void refreshTasks(selectedWorkspaceId, selectedSessionId)
      }
      if (event.method === "session/status") {
        setRunning(params.status === "queued")
        void refreshTasks(selectedWorkspaceId, selectedSessionId)
      }
    })
  }, [bridge, refreshDashboard, refreshTasks, selectedSessionId, selectedWorkspaceId])

  const gate = sendGate({ model, sandbox })
  const conversation = selectedWorkspaceId === undefined || selectedSessionId === undefined
    ? undefined
    : {
        rows: projectTimeline(eventWindow.events),
        canSend: gate.canSend,
        sendReason: gate.reason,
        running: running || sending,
        queue,
        tasks,
        taskError,
        onPrompt: async (text: string): Promise<void> => {
          setSending(true)
          try {
            await bridge.request({
              kind: "session/prompt", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, prompt: text,
            })
          } finally {
            setSending(false)
          }
          void refreshHistory(selectedWorkspaceId, selectedSessionId)
          void refreshTasks(selectedWorkspaceId, selectedSessionId)
          void refreshDashboard(selectedWorkspaceId)
        },
        onCancel: () => {
          void bridge.request({ kind: "session/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
            .then(() => { setRunning(false) })
            .catch(() => undefined)
        },
        onCancelTask: (taskId: string) => {
          void bridge.request({ kind: "session/tasks/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, id: taskId })
            .then(() => refreshTasks(selectedWorkspaceId, selectedSessionId))
            .catch(() => undefined)
        },
        onCancelQueue: (queueId: string) => {
          void bridge.request({ kind: "session/queue/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, id: queueId })
            .then(() => refreshTasks(selectedWorkspaceId, selectedSessionId))
            .catch(() => undefined)
        },
      }

  return (
    <Workbench
      bridge={bridge}
      workspaces={workspaces}
      dashboard={dashboard}
      capabilities={capabilities}
      sandbox={sandbox}
      error={error}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedSessionId={selectedSessionId}
      conversation={conversation}
      onSelectWorkspace={(workspaceId) => {
        setSelectedWorkspaceId(workspaceId)
        setSelectedSessionId(undefined)
        setDashboard(undefined)
      }}
      onSelectSession={setSelectedSessionId}
      onSessionsChanged={() => {
        if (selectedWorkspaceId !== undefined) void refreshDashboard(selectedWorkspaceId)
      }}
    />
  )
}
