import { useCallback, useEffect, useRef, useState } from "react"
import { retireSessionDraft } from "./session/Composer.tsx"
import type { HistorySelection } from "./session/SessionSearch.tsx"
import type { HistoryRequest } from "./session/SessionHistoryView.tsx"
import type { ProjectFilesRequest } from "@i-harness/desktop-gateway/src/project-files.ts"
import type { ExternalFileTarget, ProjectFileTarget } from "./session/file-navigation.ts"
import type {
  AgentTaskView,
  HistoryRange,
  SessionDashboardResult,
  SessionModelState,
  SessionModelSelection,
  SessionQueueItem,
} from "@i-harness/sdk"
import type { SandboxState } from "../main/sdk-runtime.ts"
import type { WorkspaceEntry } from "../main/workspaces.ts"
import type { ProjectEntry } from "../main/projects.ts"
import type { DesktopBridge } from "../shared/bridge.ts"
import type { DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"
import {
  applyHistory,
  applyNotification,
  emptyEventWindow,
  timelineEvents,
  markDisconnected,
  MAX_RETAINED_EVENTS,
  type EventWindow,
  type WireEvent,
} from "./session/event-window.ts"
import { loadHistory, loadRecentHistory, type HistoryPageRequest } from "./session/history.ts"
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
import { useUiStore } from "./shell/ui-store.ts"
import { createRefreshScheduler } from "./session/refresh-scheduler.ts"

const HISTORY_LIMIT = 500
const HISTORY_MAX_PAGES = 40

/** The renderer data layer: it owns the bridge, selection and refresh rules;
 * the workbench below renders exactly what it is told. */
export function App({ bridge }: { bridge: DesktopBridge }) {
  const t = useText()
  const locale = useLocale((state) => state.locale)
  const providerRevision = useUiStore((state) => state.providerRevision)
  useEffect(() => {
    void bridge.request({ kind: "desktop/local/configure", locale }).catch(() => undefined)
  }, [bridge, locale])
  const textRef = useRef(t)
  textRef.current = t
  const workStateSupported = useRef(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([])
  const selectedWorkspaceId = useUiStore((state) => state.selectedWorkspaceId)
  const selectedSessionId = useUiStore((state) => state.selectedSessionId)
  const setSelectedWorkspaceId = useUiStore((state) => state.setSelectedWorkspaceId)
  const setSelectedSessionId = useUiStore((state) => state.setSelectedSessionId)
  const [dashboard, setDashboard] = useState<SessionDashboardResult>()
  const [projects, setProjects] = useState<ProjectEntry[]>()
  const [projectError, setProjectError] = useState<string>()
  const [selectedProjectId, setSelectedProjectId] = useState<string>()
  const [projectBinding, setProjectBinding] = useState<{ workspaceId: string; sessionId: string; projectId?: string; error?: string }>()
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<{ workspaceId: string; value: Record<string, string[]> }>()
  const capabilitiesReady = selectedWorkspaceId !== undefined && capabilitySnapshot?.workspaceId === selectedWorkspaceId
  const capabilities = capabilitiesReady ? capabilitySnapshot.value : {}
  const durableInputSupported = useRef(false)
  durableInputSupported.current = capabilities["desktop-input"]?.includes("1") === true
  const [queueResumable, setQueueResumable] = useState(false)
  workStateSupported.current = capabilities["desktop-work-state"]?.includes("1") === true
  const [sandbox, setSandbox] = useState<SandboxState>()
  const [error, setError] = useState<string>()
  const [eventWindow, setEventWindow] = useState<EventWindow>(() => emptyEventWindow())
  const [model, setModel] = useState<SessionModelState>()
  const [queue, setQueue] = useState<SessionQueueItem[]>()
  const [tasks, setTasks] = useState<AgentTaskView[]>()
  const [taskError, setTaskError] = useState<string>()
  const [taskActionFailure, setTaskActionFailure] = useState<{ scope: { workspaceId?: string; sessionId?: string }; message: string }>()
  const [historyError, setHistoryError] = useState<string>()
  const [historyCount, setHistoryCount] = useState<number>()
  const [workStateResult, setWorkStateResult] = useState<{ scope: { workspaceId?: string; sessionId?: string }; view: DesktopWorkStateView }>()
  const [workStateFailure, setWorkStateFailure] = useState<{ scope: { workspaceId?: string; sessionId?: string }; message: string }>()
  const [running, setRunning] = useState(false)
  const runningRevision = useRef(0)
  const [executionError, setExecutionError] = useState<string>()
  const operations = useSessionOperation(bridge, durableInputSupported.current)
  const operation = selectedWorkspaceId && selectedSessionId ? operations.states[operationKey(selectedWorkspaceId, selectedSessionId)] : undefined
  const sending = operation?.busy === true && operation.kind !== "model"
  const [connection, setConnection] = useState<"online" | "offline" | "connecting" | "reconnecting">("online")
  const interactions = usePendingInteractions(bridge, selectedWorkspaceId)
  const pending = interactions.pending
  const [reviewChanges, setReviewChanges] = useState<ReviewChanges>()
  const [reviewError, setReviewError] = useState<string>()
  const [reviewSelected, setReviewSelected] = useState<{ path: string; mode: "diff" | "preview" }>()
  const [reviewDiff, setReviewDiff] = useState<ReviewText>()
  const [reviewPreview, setReviewPreview] = useState<ReviewText>()
  const [historyTarget, setHistoryTarget] = useState<HistorySelection>()
  const [projectOpenFile, setProjectOpenFile] = useState<ProjectFileTarget>()
  const [externalOpenFile, setExternalOpenFile] = useState<ExternalFileTarget>()
  useEffect(() => { setProjectOpenFile(undefined); setExternalOpenFile(undefined) }, [selectedWorkspaceId, selectedSessionId, selectedProjectId])
  const projectFileRequest = useCallback((request: ProjectFilesRequest) => bridge.request(request), [bridge])
  const historyRequest = useCallback((request: HistoryRequest) => bridge.request(request) as Promise<HistoryRange>, [bridge])
  useEffect(() => {
    if (historyTarget && (historyTarget.workspaceId !== selectedWorkspaceId || historyTarget.sessionId !== selectedSessionId)) setHistoryTarget(undefined)
  }, [selectedWorkspaceId, selectedSessionId, historyTarget])
  const [retryNonce, setRetryNonce] = useState(0)
  const cursorRef = useRef(0)
  const chunkBuffer = useRef<WireEvent[]>([])
  const chunkFrame = useRef<number | undefined>(undefined)
  const selection = useRef({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
  const restoredSelections = useRef(new Map<string, { workspaceId: string | undefined; sessionId: string | undefined }>())
  if (selection.current.workspaceId !== selectedWorkspaceId || selection.current.sessionId !== selectedSessionId) {
    selection.current = { workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }
  }
  const reviewRequest = useRef(0)
  const navigationVersion = useRef(0)
  const reviewChangesRequest = useRef(0)
  const modelRequest = useRef(0)
  const dashboardRequest = useRef(0)
  const dashboardApplied = useRef(0)
  const reconciledWorkspaces = useRef(new Set<string>())
  const tasksRequest = useRef(0)
  const workStateRequest = useRef(0)
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

  const refreshProjects = useCallback(async (): Promise<ProjectEntry[]> => {
    try {
      const value = await bridge.request({ kind: "projects/list" })
      const rows = Array.isArray(value) ? value as ProjectEntry[] : []
      setProjects(rows); setProjectError(undefined)
      return rows
    } catch (error) { setProjectError(error instanceof Error ? error.message : String(error)); throw error }
  }, [bridge])

  useEffect(() => { void refreshProjects().catch(() => undefined) }, [refreshProjects])
  useEffect(() => {
    let active = true
    void bridge.request({ kind: "desktop/local/state" }).then((value) => {
      if (active && value && typeof value === "object") useUiStore.getState().setFollowupDelivery((value as { followupDelivery?: unknown }).followupDelivery === "steer" ? "steer" : "queue")
    }).catch(() => undefined)
    return () => { active = false }
  }, [bridge])

  const selectedBinding = projectBinding?.workspaceId === selectedWorkspaceId && projectBinding?.sessionId === selectedSessionId && !projectBinding?.error ? projectBinding : undefined
  const activeProjectId = selectedSessionId
    ? projects?.find(project => project.id === selectedBinding?.projectId)?.id
    : projects?.find(project => project.id === selectedProjectId)?.id
  const projectScopeSupported = capabilities["desktop-project-scope"]?.includes("1") === true
  const projectReady = !projectScopeSupported || !!(projectBinding && projectBinding.workspaceId === selectedWorkspaceId && projectBinding.sessionId === selectedSessionId && !projectBinding.error)
  useEffect(() => {
    if (!projectScopeSupported || !selectedWorkspaceId || !selectedSessionId) return
    let active = true
    const workspaceId = selectedWorkspaceId, sessionId = selectedSessionId
    setProjectBinding(undefined)
    void bridge.request({ kind: "desktop/session/project/state", workspaceId, sessionId }).then((value) => {
      if (!active) return
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid conversation project owner")
      const owner = value as { sessionId?: unknown; projectId?: unknown }
      if (owner.sessionId !== sessionId || owner.projectId !== undefined && (typeof owner.projectId !== "string" || owner.projectId === "")) throw new Error("Invalid conversation project owner")
      setProjectBinding({ workspaceId, sessionId, ...(typeof owner.projectId === "string" ? { projectId: owner.projectId } : {}) })
    }).catch((error) => { if (active) setProjectBinding({ workspaceId, sessionId, error: error instanceof Error ? error.message : String(error) }) })
    return () => { active = false }
  }, [bridge, projectScopeSupported, selectedWorkspaceId, selectedSessionId, retryNonce])

  const refreshDashboard = useCallback(async (workspaceId: string): Promise<void> => {
    const scope = workspaceSelection.current
    if (scope.workspaceId !== workspaceId) return
    const request = ++dashboardRequest.current
    const result = await bridge.request({ kind: "session/dashboard", workspaceId })
    if (workspaceSelection.current !== scope || request < dashboardApplied.current) return
    dashboardApplied.current = request
    setDashboard(result as SessionDashboardResult)
  }, [bridge])

  const refreshTasks = useCallback(async (workspaceId: string, sessionId: string): Promise<void> => {
    const scope = selection.current
    if (scope.workspaceId !== workspaceId || scope.sessionId !== sessionId) return
    const request = ++tasksRequest.current
    const statusRevision = runningRevision.current
    try {
      const [queueRows, taskRows] = await Promise.all([
        bridge.request({ kind: durableInputSupported.current ? "desktop/session/input/state" : "session/queue", workspaceId, sessionId }),
        bridge.request({ kind: "session/tasks", workspaceId, sessionId }),
      ])
      if (selection.current !== scope || request !== tasksRequest.current) return
      const items = Array.isArray(queueRows) ? queueRows as SessionQueueItem[] : (queueRows as { items: SessionQueueItem[] }).items
      setQueue(items)
      // A status notification received during this read is newer than its snapshot.
      if (statusRevision === runningRevision.current) setRunning(items.some(row => row.state === "running"))
      setQueueResumable(!Array.isArray(queueRows) && (queueRows as { resumable: boolean }).resumable)
      setTasks(taskRows as AgentTaskView[])
      setTaskError(undefined)
    } catch (reason) {
      if (selection.current === scope && request === tasksRequest.current) setTaskError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [bridge])

  const refreshWorkState = useCallback(async (workspaceId: string, sessionId: string): Promise<void> => {
    const scope = selection.current
    if (scope.workspaceId !== workspaceId || scope.sessionId !== sessionId) return
    const request = ++workStateRequest.current
    try {
      const view = await bridge.request({ kind: "desktop/session/work-state", workspaceId, sessionId }) as DesktopWorkStateView
      if (selection.current !== scope || request !== workStateRequest.current) return
      setWorkStateResult({ scope, view })
      setWorkStateFailure(undefined)
    } catch (reason) {
      if (selection.current === scope && request === workStateRequest.current) {
        setWorkStateResult(undefined)
        setWorkStateFailure({ scope, message: reason instanceof Error ? reason.message : String(reason) })
      }
    }
  }, [bridge])

  const refreshChanges = useCallback(async (workspaceId: string): Promise<ReviewChanges | undefined> => {
    const scope = workspaceSelection.current
    if (scope.workspaceId !== workspaceId) return
    const request = ++reviewChangesRequest.current
    try {
      const result = await bridge.request({ kind: "desktop/review/changes", workspaceId }) as ReviewChanges
      if (workspaceSelection.current !== scope || reviewChangesRequest.current !== request) return
      setReviewChanges(result)
      setReviewError(undefined)
      return result
    } catch (reason) {
      if (workspaceSelection.current === scope && reviewChangesRequest.current === request) setReviewError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [bridge])

  const pageHistory = useCallback(async (
    workspaceId: string,
    sessionId: string,
    afterSeq: number,
  ): Promise<void> => {
    const scope = selection.current
    if (scope.workspaceId !== workspaceId || scope.sessionId !== sessionId) return
    const request = async (params: HistoryPageRequest) => {
      if (selection.current !== scope) throw new Error("History selection changed")
      return bridge.request({
        kind: "session/history", workspaceId, sessionId, afterSeq: params.afterSeq, limit: params.limit,
      }) as Promise<HistoryRange>
    }
    try {
      const load = afterSeq === 0
        ? await loadRecentHistory(request, { limit: HISTORY_LIMIT, maxEvents: MAX_RETAINED_EVENTS })
        : await loadHistory(request, { afterSeq, limit: HISTORY_LIMIT, maxPages: HISTORY_MAX_PAGES })
      if (selection.current !== scope) return
      setEventWindow((current) => applyHistory(current, { events: load.events, nextSeq: load.cursor }))
      setHistoryError(undefined)
      if (afterSeq === 0 || !load.exhausted) setHistoryCount((load.startSeq ?? 0) > 0 || !load.exhausted ? load.events.length : undefined)
    } catch (reason) {
      if (selection.current === scope) setHistoryError(reason instanceof Error ? reason.message : String(reason))
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
    const capabilityScope = workspaceSelection.current
    setCapabilitySnapshot(undefined)
    setSandbox(undefined)
    setConnection((current) => current === "reconnecting" ? "reconnecting" : "connecting")
    // Keep the first selection across failed bootstrap attempts and StrictMode
    // effect replay. A retry may reconcile that restored selection, never a
    // newer selection made by the user after the original attempt started.
    const restoredSelection = restoredSelections.current.get(selectedWorkspaceId) ?? selection.current
    restoredSelections.current.set(selectedWorkspaceId, restoredSelection)
    const dashboardVersion = ++dashboardRequest.current
    void (async () => {
      try {
        const [dashboardResult, capabilitiesResult, sandboxResult] = await Promise.all([
          bridge.request({ kind: "session/dashboard", workspaceId: selectedWorkspaceId }),
          bridge.request({ kind: "desktop/capabilities", workspaceId: selectedWorkspaceId }),
          bridge.request({ kind: "workspace/sandbox/state", workspaceId: selectedWorkspaceId }),
        ])
        if (!active || workspaceSelection.current !== capabilityScope) return
        if (dashboardVersion >= dashboardApplied.current) {
          dashboardApplied.current = dashboardVersion
          const initialDashboard = dashboardResult as SessionDashboardResult
          setDashboard(initialDashboard)
          if (!reconciledWorkspaces.current.has(selectedWorkspaceId)
            && selection.current === restoredSelection && restoredSelection.sessionId
            && !initialDashboard.listingUnavailable
            && !initialDashboard.sessions.some((row) => row.id === restoredSelection.sessionId)) {
            setSelectedSessionId(undefined)
          }
          if (!initialDashboard.listingUnavailable) reconciledWorkspaces.current.add(selectedWorkspaceId)
        }
        setCapabilitySnapshot({ workspaceId: selectedWorkspaceId, value: (capabilitiesResult ?? {}) as Record<string, string[]> })
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
    const refresh = createRefreshScheduler(() => Promise.allSettled([
      refreshDashboard(selectedWorkspaceId),
      ...(selectedSessionId ? [refreshTasks(selectedWorkspaceId, selectedSessionId)] : []),
    ]))
    const unsubscribe = bridge.onEvent((event) => {
      if (event.kind === "window/state") return
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
        if (info.kind === "status") refresh.schedule()
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
          const type = (params.event as WireEvent).type
          if ((type === "todo/write" || type === "goal/change") && workStateSupported.current) void refreshWorkState(selectedWorkspaceId, selectedSessionId)
        }
        refresh.schedule()
        return
      }
      runningRevision.current++
      setRunning(info.status === "queued")
      const statusError = (event.params as { error?: unknown })?.error
      if (info.status === "failed" && typeof statusError === "string") setExecutionError(statusError)
      else if (info.status === "queued") setExecutionError(undefined)
      refresh.schedule()
    })
    return () => { unsubscribe(); refresh.dispose() }
  }, [bridge, interactions.update, refreshDashboard, refreshTasks, refreshWorkState, selectedSessionId, selectedWorkspaceId])

  const workStateEnabled = capabilities["desktop-work-state"]?.includes("1") === true
  useEffect(() => {
    if (!workStateEnabled || !selectedWorkspaceId || !selectedSessionId) return
    void refreshWorkState(selectedWorkspaceId, selectedSessionId)
  }, [workStateEnabled, selectedWorkspaceId, selectedSessionId, retryNonce, refreshWorkState])

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
    setHistoryError(undefined)
    setHistoryCount(undefined)
    setRunning(false)
    runningRevision.current++
    setExecutionError(undefined)
    setQueueResumable(false)
    chunkBuffer.current.length = 0
    void (async () => {
      try {
        await pageHistory(selectedWorkspaceId, selectedSessionId, 0)
      } catch (reason) {
        if (active) setTaskError(reason instanceof Error ? reason.message : String(reason))
      }
      try {
        if (!active) return
        const version = ++modelRequest.current
        const modelState = await bridge.request({
          kind: "session/model/state", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId,
        })
        if (active && version === modelRequest.current) setModel(modelState as SessionModelState)
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

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedSessionId || operation?.kind !== "model" || operation.busy) return
    const scope = selection.current
    const version = ++modelRequest.current
    let active = true
    void bridge.request({ kind: "session/model/state", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }).then((result) => {
      if (active && selection.current === scope && version === modelRequest.current) setModel(result as SessionModelState)
    }).catch((reason: unknown) => { if (active && selection.current === scope) setTaskError(String(reason)) })
    return () => { active = false }
  }, [bridge, operation, selectedSessionId, selectedWorkspaceId])

  useEffect(() => {
    if (!providerRevision || !selectedWorkspaceId || !selectedSessionId || !model || model.status === "ready") return
    const scope = selection.current
    const version = ++modelRequest.current
    let active = true
    void bridge.request({ kind: "session/model/state", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }).then((result) => {
      if (active && selection.current === scope && version === modelRequest.current) setModel(result as SessionModelState)
    }).catch((reason: unknown) => { if (active && selection.current === scope) setTaskError(String(reason)) })
    return () => { active = false }
  }, [bridge, providerRevision, selectedWorkspaceId, selectedSessionId, model?.status])

  const gate = sendGate({ model, sandbox, connection }, t)
  const conversation = selectedWorkspaceId === undefined || selectedSessionId === undefined
    ? undefined
    : {
        rows: projectTimeline(timelineEvents(eventWindow)),
        canSend: gate.canSend && projectReady && !(operation?.busy && operation.kind !== "prompt"),
        projectReady,
        sendReason: !projectReady ? projectBinding?.error ?? t("正在套用專案資料夾…") : operation?.kind === "compact" && operation.busy ? t("正在壓縮上下文") : gate.reason,
        executionError,
        running: running || sending,
        modelLabel: model?.status === "ready" ? model.label : undefined,
        modelState: model,
        onSetModel: async (selectionValue: SessionModelSelection) => {
          const scope = selection.current
          await operations.changeModel(selectedWorkspaceId, selectedSessionId, selectionValue)
          if (selection.current !== scope) return
          void refreshDashboard(selectedWorkspaceId)
        },
        operation,
        canCompact: gate.canSend && !running && !operation?.busy && !(queue?.length),
        onCompact: async (instructions?: string): Promise<void> => {
          const scope = selection.current
          await operations.run(selectedWorkspaceId, selectedSessionId, "compact", instructions)
          if (selection.current === scope) await pageHistory(selectedWorkspaceId, selectedSessionId, cursorRef.current)
        },
        queue,
        queueResumable,
        onResumeQueue: async () => {
          const scope = selection.current
          try {
            await bridge.request({ kind: "desktop/session/input/resume", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
            if (selection.current === scope) setTaskActionFailure(undefined)
            await refreshTasks(selectedWorkspaceId, selectedSessionId)
          } catch (reason) {
            if (selection.current === scope) setTaskActionFailure({ scope, message: reason instanceof Error ? reason.message : String(reason) })
            throw reason
          }
        },
        onSteer: async (text: string, context?: string, images?: import("@i-harness/sdk").ImageInput[], onAdmitted?: () => void) => {
          if (capabilities["desktop-project-scope"]?.includes("1")) await bridge.request({ kind: "desktop/session/project/state", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
          await operations.run(selectedWorkspaceId, selectedSessionId, "prompt", text, context, images, onAdmitted, "steer")
          void refreshTasks(selectedWorkspaceId, selectedSessionId)
        },
        tasks,
        workState: workStateResult?.scope === selection.current ? workStateResult.view : undefined,
        workStateError: workStateFailure?.scope === selection.current ? workStateFailure.message : undefined,
        onRetryWorkState: () => { void refreshWorkState(selectedWorkspaceId, selectedSessionId) },
        onWriteTodos: async (input: import("@i-harness/desktop-gateway/src/work-state.ts").DesktopTodoWriteInput) => {
          const scope = selection.current
          try {
            const view = await bridge.request({ kind: "desktop/session/todo/write", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, input }) as DesktopWorkStateView
            if (selection.current === scope) setWorkStateResult({ scope, view })
          } catch (error) { await refreshWorkState(selectedWorkspaceId, selectedSessionId); throw error }
        },
        taskError: taskActionFailure?.scope === selection.current ? taskActionFailure.message : taskError,
        historyError,
        historyNotice: historyCount === undefined ? undefined : t("歷史視窗已載入 {count} 筆；可使用會話搜尋查找其他內容。", { count: historyCount }),
        pending: pendingForSession(pending, selectedSessionId),
        onPrompt: async (text: string, context?: string, images?: import("@i-harness/sdk").ImageInput[], onAdmitted?: () => void): Promise<void> => {
          const scope = selection.current
          if (capabilities["desktop-project-scope"]?.includes("1")) await bridge.request({ kind: "desktop/session/project/state", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
          await operations.run(selectedWorkspaceId, selectedSessionId, "prompt", text, context, images, onAdmitted)
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
            .then(() => { if (selection.current === scope) { setTaskActionFailure(undefined); return refreshTasks(selectedWorkspaceId, selectedSessionId) } })
            .catch((reason: unknown) => { if (selection.current === scope) setTaskActionFailure({ scope, message: reason instanceof Error ? reason.message : String(reason) }) })
        },
        onCancelTask: (taskId: string) => {
          const scope = selection.current
          void bridge.request({ kind: "session/tasks/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, id: taskId })
            .then(() => { if (selection.current === scope) setTaskActionFailure(undefined); return refreshTasks(selectedWorkspaceId, selectedSessionId) })
            .catch((reason: unknown) => { if (selection.current === scope) setTaskActionFailure({ scope, message: reason instanceof Error ? reason.message : String(reason) }) })
        },
        onCancelQueue: (queueId: string) => {
          const scope = selection.current
          void bridge.request(durableInputSupported.current
            ? { kind: "desktop/session/input/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, inputId: queueId }
            : { kind: "session/queue/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, id: queueId })
            .then(() => { if (selection.current === scope) setTaskActionFailure(undefined); return refreshTasks(selectedWorkspaceId, selectedSessionId) })
            .catch((reason: unknown) => { if (selection.current === scope) setTaskActionFailure({ scope, message: reason instanceof Error ? reason.message : String(reason) }) })
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
          void refreshTasks(selectedWorkspaceId, sessionId)
        },
      }

  return (
    <Workbench
      onSandboxChange={(mode) => { if (selectedWorkspaceId === workspaceSelection.current.workspaceId) setSandbox({ mode, source: "settings", wired: true }) }}
      bridge={bridge}
      workspaces={workspaces}
      projects={projects}
      selectedProjectId={activeProjectId}
      projectContext={selectedSessionId
        ? !capabilitiesReady ? { status: "loading" }
          : !projectScopeSupported || projectError || projectBinding?.workspaceId === selectedWorkspaceId && projectBinding?.sessionId === selectedSessionId && projectBinding.error ? { status: "unavailable" }
          : !selectedBinding || projects === undefined ? { status: "loading" }
          : { status: "ready", projectId: selectedBinding.projectId, projectName: projects.find(project => project.id === selectedBinding.projectId)?.name }
        : projects === undefined ? { status: projectError ? "unavailable" : "loading" }
          : { status: "ready", projectId: activeProjectId, projectName: projects.find(project => project.id === activeProjectId)?.name }}
      onProjectsChanged={async () => { await Promise.all([refreshProjects(), refreshWorkspaces()]) }}
      onSelectProject={(id) => {
        navigationVersion.current++
        setSelectedProjectId(id)
        const project = projects?.find((row) => row.id === id)
        const workspaceId = project?.primaryWorkspaceId ?? project?.workspaceIds[0]
        if (workspaceId !== selection.current.workspaceId) { setDashboard(undefined); setConnection("connecting") }
        setSelectedWorkspaceId(workspaceId); setSelectedSessionId(undefined)
        useUiStore.getState().setSurface(workspaceId ? "conversation" : "projects")
      }}
      onSelectSessionInWorkspace={(workspaceId, sessionId, projectId) => {
        navigationVersion.current++
        setHistoryTarget(undefined)
        if (workspaceId !== selection.current.workspaceId) { setDashboard(undefined); setConnection("connecting") }
        setSelectedProjectId(projectId)
        setSelectedWorkspaceId(workspaceId); setSelectedSessionId(sessionId)
      }}
      onManageSessionInWorkspace={async (workspaceId, sessionId, action, title) => {
        const scope = selection.current
        const result = await bridge.request({ kind: "desktop/session/manage", workspaceId, sessionId, action, ...(title !== undefined ? { title } : {}) }) as { sessionId: string }
        if (selection.current.workspaceId === workspaceId) {
          await refreshDashboard(workspaceId)
          if (action === "archive" && selection.current.workspaceId === workspaceId && selection.current.sessionId === sessionId) setSelectedSessionId(undefined)
        }
        if (action === "fork" && selection.current === scope) { if (workspaceId !== selection.current.workspaceId) setDashboard(undefined); setSelectedWorkspaceId(workspaceId); setSelectedSessionId(result.sessionId); useUiStore.getState().setSurface("conversation") }
      }}
      dashboard={dashboard}
      attentionBySession={pending.reduce<Record<string, number>>((counts, row) => { counts[row.sessionId] = (counts[row.sessionId] ?? 0) + 1; return counts }, {})}
      capabilities={capabilities}
      capabilitiesReady={capabilitiesReady}
      sandbox={sandbox}
      error={error ?? projectError}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedSessionId={selectedSessionId}
      connection={selectedWorkspaceId ? connection : undefined}
      conversation={conversation}
      onSelectHistory={(target) => {
        const scope = selection.current
        const version = ++navigationVersion.current
        if (!Number.isSafeInteger(target.seq) || target.seq < 0) { setError("Invalid history position"); return }
        void bridge.request({ kind: "desktop/notifications/target", workspaceId: target.workspaceId, sessionId: target.sessionId }).then(value => {
          if (selection.current !== scope || navigationVersion.current !== version) return
          const validated = value as { workspaceId: string; sessionId: string; projectId?: string }
          if (validated.workspaceId !== target.workspaceId || validated.sessionId !== target.sessionId) throw new Error("Invalid history target")
          if (target.workspaceId !== scope.workspaceId) { setDashboard(undefined); setConnection("connecting") }
          setSelectedProjectId(validated.projectId); setHistoryTarget({ ...target }); setSelectedWorkspaceId(target.workspaceId); setSelectedSessionId(target.sessionId)
          useUiStore.getState().setSurface("conversation")
        }).catch(reason => { if (selection.current === scope && navigationVersion.current === version) setError(String(reason)) })
      }}
      onOpenProjectFile={(ref) => setProjectOpenFile({ ...ref })}
      onOpenExternalFile={(target) => setExternalOpenFile({ ...target, reference: { ...target.reference } })}
      onBatchSessions={async (workspaceId, command) => {
        const scope = selection.current
        const result = await bridge.request({ kind: "desktop/session/batch", workspaceId, command, confirmed: true }) as import("./session/SessionManager.tsx").ManageSessionBatchResult
        const successes = result.results.filter(row => row.ok)
        if (command.action === "delete") for (const row of successes) retireSessionDraft(workspaceId, row.sessionId)
        if (successes.length) {
          await Promise.all([refreshProjects(), refreshDashboard(workspaceId)])
          if (selection.current === scope && scope.workspaceId === workspaceId) {
            const current = successes.find(row => row.sessionId === scope.sessionId)
            if (current) {
              if (command.action === "archive" || command.action === "delete") { setHistoryTarget(undefined); setSelectedSessionId(undefined) }
              else if (command.action === "move") { setSelectedProjectId(command.projectId); setProjectBinding(undefined) }
            }
            setRetryNonce(value => value + 1)
          }
        }
        return result
      }}
      historicalView={historyTarget && historyTarget.workspaceId === selectedWorkspaceId && historyTarget.sessionId === selectedSessionId ? { selection: historyTarget, request: historyRequest, onLatest: () => setHistoryTarget(undefined) } : undefined}
      review={{
        projectFiles: selectedWorkspaceId && capabilities["desktop-project-files"]?.includes("1") ? { selection: { workspaceId: selectedWorkspaceId, ...(selectedSessionId ? { sessionId: selectedSessionId } : {}), ...(selectedBinding?.projectId ? { projectId: selectedBinding.projectId } : activeProjectId ? { projectId: activeProjectId } : {}) }, request: projectFileRequest, openFile: projectOpenFile, externalOpenFile } : undefined,
        onSaveFile: async (path, text, expectedRevision) => {
          if (!selectedWorkspaceId) throw new Error("No workspace selected")
          const result = await bridge.request({ kind: "desktop/review/file/save", workspaceId: selectedWorkspaceId, path, text, expectedRevision }) as import("./review/SourceFileEditor.tsx").ReviewSaveResult
          if (result.kind === "saved") void refreshChanges(selectedWorkspaceId)
          return result
        },
        onStage: async (path) => {
          if (!selectedWorkspaceId) throw new Error("No workspace selected")
          const result = await bridge.request({ kind: "desktop/review/stage", workspaceId: selectedWorkspaceId, path }) as import("./review/ReviewPane.tsx").ReviewGitResult
          await refreshChanges(selectedWorkspaceId)
          return result
        },
        onUnstage: async (path) => {
          if (!selectedWorkspaceId) throw new Error("No workspace selected")
          const result = await bridge.request({ kind: "desktop/review/unstage", workspaceId: selectedWorkspaceId, path }) as import("./review/ReviewPane.tsx").ReviewGitResult
          await refreshChanges(selectedWorkspaceId)
          return result
        },
        onCommit: async (message) => {
          if (!selectedWorkspaceId) throw new Error("No workspace selected")
          const result = await bridge.request({ kind: "desktop/review/commit", workspaceId: selectedWorkspaceId, message }) as import("./review/ReviewPane.tsx").ReviewCommitResult
          await refreshChanges(selectedWorkspaceId)
          return result
        },
        changes: reviewChanges,
        error: reviewError,
        selected: reviewSelected,
        diff: reviewDiff,
        preview: reviewPreview,
        onSelect: (path, mode) => { void selectReview(path, mode) },
        onRefresh: () => {
          if (selectedWorkspaceId === undefined) return
          const scope = workspaceSelection.current
          const detailRequest = reviewRequest.current
          const selected = reviewSelected
          void refreshChanges(selectedWorkspaceId).then((changes) => {
            if (!changes || workspaceSelection.current !== scope || reviewRequest.current !== detailRequest) return
            const row = changes.kind === "ok" ? changes.files.find((file) => file.path === selected?.path) : undefined
            if (selected && (selected.mode === "preview" || row?.canDiff)) {
              void selectReview(selected.path, selected.mode)
              return
            }
            reviewRequest.current++ // invalidate an old diff/preview request
            setReviewSelected(undefined)
            setReviewDiff(undefined)
            setReviewPreview(undefined)
          })
        },
      }}
      onSelectWorkspace={(workspaceId, projectId) => {
        navigationVersion.current++
        setHistoryTarget(undefined)
        setSelectedProjectId(projectId)
        if (workspaceId !== selectedWorkspaceId) {
          setConnection("connecting")
          setSelectedWorkspaceId(workspaceId)
          setDashboard(undefined)
        }
        setSelectedSessionId(undefined)
      }}
      onSelectSession={(id) => { navigationVersion.current++; setHistoryTarget(undefined); setSelectedSessionId(id) }}
      onRewindComplete={(workspaceId, sessionId) => {
        if (selection.current.workspaceId !== workspaceId) return
        void refreshDashboard(workspaceId)
        void refreshChanges(workspaceId)
        if (selection.current.sessionId === sessionId) setRetryNonce((value) => value + 1)
      }}
      onManageSession={async (sessionId, action, title) => {
        if (!selectedWorkspaceId) return
        const scope = selection.current
        const result = await bridge.request({ kind: "desktop/session/manage", workspaceId: selectedWorkspaceId, sessionId, action, ...(title !== undefined ? { title } : {}) }) as { sessionId: string }
        await refreshDashboard(selectedWorkspaceId)
        if (selection.current !== scope) return
        if (action === "archive" && selectedSessionId === sessionId) setSelectedSessionId(undefined)
        if (action === "fork") { setSelectedSessionId(result.sessionId); useUiStore.getState().setSurface("conversation") }
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
