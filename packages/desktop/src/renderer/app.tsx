import { useCallback, useEffect, useRef, useState } from "react"
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
import {
  applyHistory,
  applyNotification,
  emptyEventWindow,
  markDisconnected,
  type EventWindow,
  type WireEvent,
} from "./session/event-window.ts"
import { loadHistory } from "./session/history.ts"
import type { InteractionReply } from "./interaction/PendingPanel.tsx"
import type { ReviewChanges, ReviewText } from "./review/ReviewPane.tsx"
import { pendingForSession, type PendingInteraction } from "./interaction/pending.ts"
import { usePendingInteractions } from "./interaction/use-pending-interactions.ts"
import { classifyNotification } from "./session/notifications.ts"
import { projectTimeline } from "./session/project.ts"
import { sendGate } from "./session/send-gate.ts"
import { Workbench } from "./shell/Workbench.tsx"
import { operationKey, useSessionOperation } from "./session/use-session-operation.ts"
import { useLocale, useText } from "./design/i18n.ts"

const HISTORY_LIMIT = 500
const HISTORY_MAX_PAGES = 40

/** The renderer data layer: it owns the bridge, selection and refresh rules;
 * the workbench below renders exactly what it is told. */
export function App({ bridge }: { bridge: DesktopBridge }) {
  const t = useText()
  const locale = useLocale((state) => state.locale)
  useEffect(() => {
    void bridge.request({ kind: "desktop/local/configure", locale }).catch(() => undefined)
  }, [bridge, locale])
  const textRef = useRef(t)
  textRef.current = t
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
  const operations = useSessionOperation(bridge)
  const operation = selectedWorkspaceId && selectedSessionId ? operations.states[operationKey(selectedWorkspaceId, selectedSessionId)] : undefined
  const sending = operation?.busy === true
  const [connection, setConnection] = useState<"online" | "offline" | "connecting" | "reconnecting">("online")
  const interactions = usePendingInteractions(bridge, selectedWorkspaceId)
  const pending = interactions.pending
  const [reviewChanges, setReviewChanges] = useState<ReviewChanges>()
  const [reviewError, setReviewError] = useState<string>()
  const [reviewSelected, setReviewSelected] = useState<{ path: string; mode: "diff" | "preview" }>()
  const [reviewDiff, setReviewDiff] = useState<ReviewText>()
  const [reviewPreview, setReviewPreview] = useState<ReviewText>()
  const [retryNonce, setRetryNonce] = useState(0)
  const cursorRef = useRef(0)
  const chunkBuffer = useRef<WireEvent[]>([])
  const chunkFrame = useRef<number | undefined>(undefined)
  const selection = useRef({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
  if (selection.current.workspaceId !== selectedWorkspaceId || selection.current.sessionId !== selectedSessionId) {
    selection.current = { workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }
  }
  const reviewRequest = useRef(0)
  const workspaceSelection = useRef({ workspaceId: selectedWorkspaceId })
  if (workspaceSelection.current.workspaceId !== selectedWorkspaceId) workspaceSelection.current = { workspaceId: selectedWorkspaceId }

  useEffect(() => {
    cursorRef.current = eventWindow.cursor
  }, [eventWindow.cursor])

  const refreshWorkspaces = useCallback(async (): Promise<WorkspaceEntry[]> => {
    const rows = await bridge.request({ kind: "workspace/list" })
    const list = rows as WorkspaceEntry[]
    setWorkspaces(list)
    return list
  }, [bridge])

  const refreshDashboard = useCallback(async (workspaceId: string): Promise<void> => {
    const scope = workspaceSelection.current
    if (scope.workspaceId !== workspaceId) return
    const result = await bridge.request({ kind: "session/dashboard", workspaceId })
    if (workspaceSelection.current !== scope) return
    setDashboard(result as SessionDashboardResult)
  }, [bridge])

  const refreshTasks = useCallback(async (workspaceId: string, sessionId: string): Promise<void> => {
    const scope = selection.current
    if (scope.workspaceId !== workspaceId || scope.sessionId !== sessionId) return
    try {
      const [queueRows, taskRows] = await Promise.all([
        bridge.request({ kind: "session/queue", workspaceId, sessionId }),
        bridge.request({ kind: "session/tasks", workspaceId, sessionId }),
      ])
      if (selection.current !== scope) return
      setQueue(queueRows as SessionQueueItem[])
      setTasks(taskRows as AgentTaskView[])
      setTaskError(undefined)
    } catch (reason) {
      if (selection.current === scope) setTaskError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [bridge])

  const refreshChanges = useCallback(async (workspaceId: string): Promise<void> => {
    const scope = workspaceSelection.current
    if (scope.workspaceId !== workspaceId) return
    try {
      const result = await bridge.request({ kind: "desktop/review/changes", workspaceId }) as ReviewChanges
      if (workspaceSelection.current !== scope) return
      setReviewChanges(result)
      setReviewError(undefined)
    } catch (reason) {
      if (workspaceSelection.current === scope) setReviewError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [bridge])

  const pageHistory = useCallback(async (
    workspaceId: string,
    sessionId: string,
    afterSeq: number,
  ): Promise<void> => {
    const scope = selection.current
    if (scope.workspaceId !== workspaceId || scope.sessionId !== sessionId) return
    const load = await loadHistory(
      (params) => bridge.request({
        kind: "session/history", workspaceId, sessionId, afterSeq: params.afterSeq, limit: params.limit,
      }) as Promise<HistoryRange>,
      { afterSeq, limit: HISTORY_LIMIT, maxPages: HISTORY_MAX_PAGES },
    )
    if (selection.current !== scope) return
    setEventWindow((current) => applyHistory(current, { events: load.events, nextSeq: load.cursor }))
    if (!load.exhausted) {
      setTaskError(textRef.current("歷史視窗已載入 {count} 筆；可使用會話搜尋查找其他內容。", { count: load.events.length }))
    }
  }, [bridge])

  useEffect(() => {
    let active = true
    void refreshWorkspaces()
      .then((list) => {
        if (!active) return
        setSelectedWorkspaceId((current) => current ?? list[0]?.id)
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { active = false }
  }, [refreshWorkspaces, retryNonce])

  useEffect(() => {
    if (selectedWorkspaceId === undefined) return
    let active = true
    setCapabilities({})
    setSandbox(undefined)
    setConnection((current) => current === "reconnecting" ? "reconnecting" : "connecting")
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
        setConnection("online")
        setError(undefined)
        if ((capabilitiesResult as Record<string, string[]> | undefined)?.["desktop-interaction"]?.includes("1")) {
          void interactions.refresh().catch((reason: unknown) => { if (active) setError(String(reason)) })
        }
      } catch (reason) {
        if (active) { setConnection("offline"); setError(reason instanceof Error ? reason.message : String(reason)) }
      }
    })()
    return () => { active = false }
  }, [bridge, interactions.refresh, retryNonce, selectedWorkspaceId])

  // Subscribe BEFORE the first history read (spec §6): a live event that lands
  // during the read must not be lost.
  useEffect(() => {
    if (selectedWorkspaceId === undefined) return
    return bridge.onEvent((event) => {
      if (event.workspaceId !== selectedWorkspaceId) return
      if (event.kind === "sdk/disconnected") {
        setConnection("offline")
        setEventWindow((current) => markDisconnected(current))
        setError(textRef.current("SDK 連線中斷：{message}", { message: event.message }))
        return
      }
      if (event.method === "desktop/interaction/request") {
        const view = event.params as PendingInteraction | undefined
        if (view === undefined || typeof view.requestId !== "string" || typeof view.sessionId !== "string") return
        interactions.update(view.requestId, view)
        return
      }
      if (event.method === "desktop/interaction/closed") {
        const params = event.params as { requestId?: unknown } | undefined
        const requestId = params?.requestId
        if (typeof requestId !== "string") return
        interactions.update(requestId)
        return
      }
      if (event.method !== "session/event" && event.method !== "session/status") return
      const info = classifyNotification(event.method, event.params)
      if (info.kind === "ignore") return
      if (info.sessionId !== selectedSessionId) {
        if (info.kind === "status") void refreshDashboard(selectedWorkspaceId)
        return
      }
      if (info.kind === "chunk") {
        const params = event.params as { event?: unknown }
        if (params.event === undefined) return
        chunkBuffer.current.push(params.event as WireEvent)
        if (chunkFrame.current === undefined) {
          chunkFrame.current = requestAnimationFrame(() => {
            chunkFrame.current = undefined
            const buffered = chunkBuffer.current.splice(0)
            if (buffered.length === 0) return
            setEventWindow((current) => buffered.reduce((next, item) => applyNotification(next, item), current))
          })
        }
        return
      }
      if (info.kind === "durable") {
        const params = event.params as { event?: unknown }
        if (params.event !== undefined) {
          setEventWindow((current) => applyNotification(current, params.event as WireEvent))
        }
        void refreshTasks(selectedWorkspaceId, info.sessionId)
        void refreshDashboard(selectedWorkspaceId)
        return
      }
      setRunning(info.status === "queued")
      void refreshTasks(selectedWorkspaceId, info.sessionId)
      void refreshDashboard(selectedWorkspaceId)
    })
  }, [bridge, interactions.update, refreshDashboard, refreshTasks, selectedSessionId, selectedWorkspaceId])

  useEffect(() => {
    if (selectedWorkspaceId === undefined) return
    setReviewChanges(undefined)
    setReviewSelected(undefined)
    setReviewDiff(undefined)
    setReviewPreview(undefined)
    setReviewError(undefined)
    void refreshChanges(selectedWorkspaceId)
  }, [refreshChanges, selectedWorkspaceId])

  const selectReview = useCallback(async (path: string, mode: "diff" | "preview"): Promise<void> => {
    if (selectedWorkspaceId === undefined) return
    const scope = workspaceSelection.current
    const request = ++reviewRequest.current
    setReviewSelected({ path, mode })
    setReviewDiff(undefined)
    setReviewPreview(undefined)
    setReviewError(undefined)
    try {
      const result = await bridge.request({
        kind: mode === "diff" ? "desktop/review/diff" : "desktop/review/file",
        workspaceId: selectedWorkspaceId,
        path,
      })
      if (workspaceSelection.current !== scope || reviewRequest.current !== request) return
      if (mode === "diff") setReviewDiff(result as ReviewText)
      else setReviewPreview(result as ReviewText)
    } catch (reason) {
      if (workspaceSelection.current === scope && reviewRequest.current === request) setReviewError(reason instanceof Error ? reason.message : String(reason))
    }
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
    chunkBuffer.current.length = 0
    void (async () => {
      try {
        await pageHistory(selectedWorkspaceId, selectedSessionId, 0)
      } catch (reason) {
        if (active) setTaskError(reason instanceof Error ? reason.message : String(reason))
      }
      try {
        const modelState = await bridge.request({
          kind: "session/model/state", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId,
        })
        if (active) setModel(modelState as SessionModelState)
      } catch (reason) {
        if (active) setTaskError(reason instanceof Error ? reason.message : String(reason))
      }
      try {
        if (active) await interactions.refresh(selectedSessionId)
      } catch (reason) {
        if (active) setTaskError(reason instanceof Error ? reason.message : String(reason))
      }
      if (active) await refreshTasks(selectedWorkspaceId, selectedSessionId)
    })()
    return () => {
      active = false
      if (chunkFrame.current !== undefined) {
        cancelAnimationFrame(chunkFrame.current)
        chunkFrame.current = undefined
      }
    }
  }, [bridge, interactions.refresh, pageHistory, refreshTasks, retryNonce, selectedSessionId, selectedWorkspaceId])

  const gate = sendGate({ model, sandbox, connection }, t)
  const conversation = selectedWorkspaceId === undefined || selectedSessionId === undefined
    ? undefined
    : {
        rows: projectTimeline(eventWindow.events),
        canSend: gate.canSend && !(operation?.kind === "compact" && operation.busy),
        sendReason: operation?.kind === "compact" && operation.busy ? t("正在壓縮上下文") : gate.reason,
        running: running || sending,
        modelLabel: model?.status === "ready" ? model.label : undefined,
        operation,
        canCompact: gate.canSend && !running && !sending && !(queue?.length),
        onCompact: async (instructions?: string): Promise<void> => {
          const scope = selection.current
          await operations.run(selectedWorkspaceId, selectedSessionId, "compact", instructions)
          if (selection.current === scope) await pageHistory(selectedWorkspaceId, selectedSessionId, cursorRef.current)
        },
        queue,
        tasks,
        taskError,
        pending: pendingForSession(pending, selectedSessionId),
        onPrompt: async (text: string): Promise<void> => {
          const scope = selection.current
          await operations.run(selectedWorkspaceId, selectedSessionId, "prompt", text)
          if (selection.current !== scope) return
          if (connection === "online") {
            void pageHistory(selectedWorkspaceId, selectedSessionId, cursorRef.current)
          }
          void refreshTasks(selectedWorkspaceId, selectedSessionId)
          void refreshDashboard(selectedWorkspaceId)
          void refreshChanges(selectedWorkspaceId)
        },
        onCancel: () => {
          const scope = selection.current
          void bridge.request({ kind: "session/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
            .then(() => { if (selection.current === scope) setRunning(false) })
            .catch((reason: unknown) => { if (selection.current === scope) setTaskError(String(reason)) })
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
        onReply: async ({ requestId, decision }: InteractionReply) => {
          const row = pending.find((candidate) => candidate.requestId === requestId)
          const sessionId = row?.sessionId ?? selectedSessionId
          await bridge.request({
            kind: "desktop/interaction/reply",
            workspaceId: selectedWorkspaceId,
            requestId,
            sessionId,
            decision,
          })
          interactions.update(requestId)
        },
      }

  return (
    <Workbench
      bridge={bridge}
      workspaces={workspaces}
      dashboard={dashboard}
      attentionBySession={pending.reduce<Record<string, number>>((counts, row) => { counts[row.sessionId] = (counts[row.sessionId] ?? 0) + 1; return counts }, {})}
      capabilities={capabilities}
      sandbox={sandbox}
      error={error}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedSessionId={selectedSessionId}
      connection={selectedWorkspaceId ? connection : undefined}
      conversation={conversation}
      review={{
        changes: reviewChanges,
        error: reviewError,
        selected: reviewSelected,
        diff: reviewDiff,
        preview: reviewPreview,
        onSelect: (path, mode) => { void selectReview(path, mode) },
        onRefresh: () => {
          if (selectedWorkspaceId !== undefined) void refreshChanges(selectedWorkspaceId)
        },
      }}
      onSelectWorkspace={(workspaceId) => {
        if (workspaceId !== selectedWorkspaceId) {
          setConnection("connecting")
          setSelectedWorkspaceId(workspaceId)
          setDashboard(undefined)
        }
        setSelectedSessionId(undefined)
      }}
      onSelectSession={setSelectedSessionId}
      onOpenWorkspace={() => {
        void (async () => {
          try {
            const opened = await bridge.request({ kind: "workspace/pick" })
            if (opened === undefined) return
            const entry = opened as WorkspaceEntry
            await refreshWorkspaces()
            setSelectedWorkspaceId(entry.id)
            if (entry.id !== selectedWorkspaceId) setConnection("connecting")
            setSelectedSessionId(undefined)
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
          }
        })()
      }}
      onRetry={() => {
        setConnection("reconnecting")
        setError(undefined)
        setRetryNonce((current) => current + 1)
      }}
      onSessionsChanged={() => {
        if (selectedWorkspaceId !== undefined) void refreshDashboard(selectedWorkspaceId)
      }}
    />
  )
}
