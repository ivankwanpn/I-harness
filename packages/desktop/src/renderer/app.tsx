import { safeCompactionBlockedReason } from "@i-harness/desktop-gateway/src/context-diagnostics.ts"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { captureSessionSubmission, consumeSessionSubmission, ComposerPreparationError, retireSessionDraft, type ComposerProps } from "./session/Composer.tsx"
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
  SessionExecutionStateNotification,
} from "@i-harness/sdk"
import type { SandboxState } from "../main/sdk-runtime.ts"
import type { WorkspaceEntry } from "../main/workspaces.ts"
import type { ProjectEntry } from "../main/projects.ts"
import type { DesktopBridge, DesktopEvent } from "../shared/bridge.ts"
import type { DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"
import {
  applyHistory,
  applyNotification,
  emptyEventWindow,
  createHistoryPreviewCache,
  RECENT_HISTORY_LIMIT,
  timelineEvents,
  markDisconnected,
  isAssistantPreview,
  updateAssistantPreview,
  MAX_RETAINED_EVENTS,
  type AssistantPreview,
  type EventWindow,
  type WireEvent,
} from "./session/event-window.ts"
import { loadHistory, loadRecentHistory, requiresHistoryTailProbe, type HistoryPageRequest } from "./session/history.ts"
import { useHistoryScroll } from "./session/use-history-scroll.ts"
import type { InteractionReply } from "./interaction/PendingPanel.tsx"
import type { ReviewChanges, ReviewText } from "./review/ReviewPane.tsx"
import { pendingForSession, type PendingInteraction } from "./interaction/pending.ts"
import { usePendingInteractions } from "./interaction/use-pending-interactions.ts"
import { affectsSessionDashboard, classifyNotification } from "./session/notifications.ts"
import { projectTimeline } from "./session/project.ts"
import { sendGate } from "./session/send-gate.ts"
import { createWorkspaceConnections } from "./session/workspace-connections.ts"
import { Workbench } from "./shell/Workbench.tsx"
import { operationKey, useSessionOperation } from "./session/use-session-operation.ts"
import { useLocale, useText } from "./design/i18n.ts"
import { useUiStore } from "./shell/ui-store.ts"
import { createRefreshScheduler } from "./session/refresh-scheduler.ts"
import { RuntimeFeedback } from "./session/RuntimeFeedback.tsx"
import { createForkOperationController, createForkCallbackAdapters } from './session/fork-operation.ts'

const HISTORY_MAX_PAGES = 40
const LAST_WORKSPACE = "ih:last-workspace"

function projectWorkspace(project: ProjectEntry, workspaces: readonly WorkspaceEntry[]): string | undefined {
  return [project.primaryWorkspaceId, ...project.workspaceIds].find(id => id !== undefined && project.workspaceIds.includes(id) && workspaces.some(workspace => workspace.id === id))
}

function startupWorkspace(workspaces: WorkspaceEntry[], projects: ProjectEntry[]): { workspaceId?: string; projectId?: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_WORKSPACE) ?? "null") as { workspaceId?: unknown; projectId?: unknown } | null
    const workspace = workspaces.find(row => row.id === saved?.workspaceId)
    if (workspace) {
      const project = projects.find(row => row.id === saved?.projectId
        && (row.workspaceIds.includes(workspace.id) || workspace.worktree?.projectId === row.id))
      return { workspaceId: workspace.id, projectId: project?.id }
    }
  } catch { /* A damaged or disabled preference still permits normal startup. */ }
  for (const project of projects) {
    const workspaceId = projectWorkspace(project, workspaces)
    if (workspaceId) {
      // A shared folder does not identify a project unless the user chose one.
      const shared = projects.some(row => row.id !== project.id && row.workspaceIds.includes(workspaceId))
      return { workspaceId, projectId: shared ? undefined : project.id }
    }
  }
  return { workspaceId: workspaces[0]?.id }
}

/** The renderer data layer: it owns the bridge, selection and refresh rules;
 * the workbench below renders exactly what it is told. */
interface PendingEcho { scope: string; token: string; text: string; inputId?: string }

function pendingEchoes(rows: PendingEcho[], scope: string, events: WireEvent[]): PendingEcho[] {
  if (!rows.length) return rows
  const admissions = new Map<string, string>()
  const settled = new Set<string>()
  for (const event of events) {
    if (event.type === "agent/input/admitted" && event.clientToken) admissions.set(event.clientToken, event.inputId)
    if (event.type === "agent/input/cancelled") settled.add(event.inputId)
    if (event.type === "user/message" && event.input?.inputId) settled.add(event.input.inputId)
  }
  const remaining: PendingEcho[] = []
  for (const row of rows) {
    const inputId = row.inputId ?? admissions.get(row.token)
    if (row.scope !== scope || (inputId && settled.has(inputId))) continue
    remaining.push(inputId && !row.inputId ? { ...row, inputId } : row)
  }
  return remaining.length === rows.length && remaining.every((row, i) => row === rows[i]) ? rows : remaining
}

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
  const inputCapabilities = capabilities["desktop-input"]
  const usesDurableInput = inputCapabilities?.includes("1") === true
  const checksProjectOnAdmission = usesDurableInput && inputCapabilities.includes("project-checked")
  const durableInputSupported = useRef(false)
  durableInputSupported.current = usesDurableInput
  const [queueResumable, setQueueResumable] = useState(false)
  workStateSupported.current = capabilities["desktop-work-state"]?.includes("1") === true
  const [sandbox, setSandbox] = useState<SandboxState>()
  const [error, setError] = useState<string>()
  const [eventWindow, setEventWindow] = useState<EventWindow>(() => emptyEventWindow())
  const [windowKey, setWindowKey] = useState<string>()
  const [historyLoading, setHistoryLoading] = useState(false)
  const eventWindowCache = useMemo(createHistoryPreviewCache, [bridge])
  const assistantPreviews = useRef(new Map<string, AssistantPreview>())
  const [optimistic, setOptimistic] = useState<PendingEcho[]>([])
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
  const executionRevision = useRef<number | undefined>(undefined)
  const operations = useSessionOperation(bridge, durableInputSupported.current)
  const operation = selectedWorkspaceId && selectedSessionId ? operations.states[operationKey(selectedWorkspaceId, selectedSessionId)] : undefined
  const sending = operation?.busy === true && operation.kind !== "model"
  const workspaceConnections = useMemo(createWorkspaceConnections, [bridge])
  const connections = useSyncExternalStore(workspaceConnections.subscribe, workspaceConnections.snapshot)
  const connection = (selectedWorkspaceId ? connections.get(selectedWorkspaceId)?.phase : undefined) ?? "connecting"
  const selectedWorkspaceEvents = useRef<((event: DesktopEvent) => void) | undefined>(undefined)
  const interactions = usePendingInteractions(bridge, selectedWorkspaceId)
  const pending = interactions.pending
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
  const selection = useRef({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
  const restoredSelections = useRef(new Map<string, { workspaceId: string | undefined; sessionId: string | undefined }>())
  if (selection.current.workspaceId !== selectedWorkspaceId || selection.current.sessionId !== selectedSessionId) {
    selection.current = { workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }
    executionRevision.current = undefined
  }
  const reviewRequest = useRef(0)
  const navigationVersion = useRef(0)
  const historySurfaceRevision = useRef(0)
  useEffect(() => {
    const unsubscribe = useUiStore.subscribe((current, previous) => {
      if (current.surface !== previous.surface) historySurfaceRevision.current++
    })
    return () => { historySurfaceRevision.current++; unsubscribe() }
  }, [])
  const modelRequest = useRef(0)
  const dashboardRequest = useRef(0)
  const dashboardApplied = useRef(0)
  const reconciledWorkspaces = useRef(new Set<string>())
  const tasksRequest = useRef(0)
  const workStateRequest = useRef(0)
  const workspaceSelection = useRef({ workspaceId: selectedWorkspaceId })
  if (workspaceSelection.current.workspaceId !== selectedWorkspaceId) workspaceSelection.current = { workspaceId: selectedWorkspaceId }
  const disconnected = useRef<typeof workspaceSelection.current | undefined>(undefined)
  // Invalidate reads when the selected transport closes, including standby.
  const disconnectRevision = useRef(0)
  // The project tree can reuse the selected workspace's original opening list.
  const openingDashboard = useRef<{
    bridge: DesktopBridge
    workspace: typeof workspaceSelection.current
    generation: number
    request: number
    result: Promise<unknown>
  } | undefined>(undefined)
  const readOpeningDashboard = useCallback((workspaceId: string) => {
    const opening = openingDashboard.current
    if (opening?.bridge === bridge && opening.workspace === workspaceSelection.current && opening.workspace.workspaceId === workspaceId
      && opening.generation === disconnectRevision.current && opening.request === dashboardRequest.current) return opening.result
  }, [bridge])

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

  useEffect(() => {
    let active = true
    void bridge.request({ kind: "desktop/local/state" }).then((value) => {
      if (active && value && typeof value === "object") useUiStore.getState().setFollowupDelivery((value as { followupDelivery?: unknown }).followupDelivery === "steer" ? "steer" : "queue")
    }).catch(() => undefined)
    return () => { active = false }
  }, [bridge])

  const currentBinding = projectBinding?.workspaceId === selectedWorkspaceId && projectBinding?.sessionId === selectedSessionId ? projectBinding : undefined
  const selectedBinding = currentBinding?.error ? undefined : currentBinding
  const activeProjectId = selectedSessionId
    ? projects?.find(project => project.id === selectedBinding?.projectId)?.id
    : projects?.find(project => project.id === selectedProjectId)?.id
  const projectScopeSupported = capabilities["desktop-project-scope"]?.includes("1") === true
  const projectReady = capabilitiesReady && (!projectScopeSupported || selectedBinding !== undefined)
  useEffect(() => {
    if (!projects || !selectedWorkspaceId || !workspaces.some(workspace => workspace.id === selectedWorkspaceId)) return
    if (selectedSessionId && (!capabilitiesReady || projectScopeSupported && !selectedBinding)) return
    const project = projects.find(row => row.id === activeProjectId)
    const workspace = workspaces.find(row => row.id === selectedWorkspaceId)
    const workspaceId = project && !project.workspaceIds.includes(selectedWorkspaceId) && !workspace?.worktree
      ? projectWorkspace(project, workspaces) : selectedWorkspaceId
    if (!workspaceId) return
    try { localStorage.setItem(LAST_WORKSPACE, JSON.stringify({ workspaceId, projectId: project?.id })) }
    catch { /* The current selection still works in memory. */ }
  }, [activeProjectId, capabilitiesReady, projects, projectScopeSupported, selectedBinding, selectedSessionId, selectedWorkspaceId, workspaces])
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
    if (openingDashboard.current?.workspace === scope) openingDashboard.current = undefined
    const request = ++dashboardRequest.current
    const result = await bridge.request({ kind: "session/dashboard", workspaceId })
    if (workspaceSelection.current !== scope || request < dashboardApplied.current) return
    dashboardApplied.current = request
    setDashboard(result as SessionDashboardResult)
  }, [bridge])
  const forkDependencies = useRef({ bridge, refreshDashboard })
  const forkOperations = useRef<ReturnType<typeof createForkOperationController> | undefined>(undefined)
  if (forkDependencies.current.bridge !== bridge) forkOperations.current?.retireNavigation()
  forkDependencies.current = { bridge, refreshDashboard }
  if (!forkOperations.current) forkOperations.current = createForkOperationController({
    bridge: { request: request => forkDependencies.current.bridge.request(request) },
    selection: () => selection.current, navigationVersion: () => navigationVersion.current,
    refresh: workspaceId => forkDependencies.current.refreshDashboard(workspaceId),
    navigate(workspaceId, sessionId) {
      navigationVersion.current++
      if (workspaceId !== selection.current.workspaceId) setDashboard(undefined)
      setHistoryTarget(undefined); setSelectedWorkspaceId(workspaceId); setSelectedSessionId(sessionId)
      useUiStore.getState().setSurface('conversation')
    },
  })
  const forkCallbacks = useRef<ReturnType<typeof createForkCallbackAdapters> | undefined>(undefined)
  if (!forkCallbacks.current) forkCallbacks.current = createForkCallbackAdapters(forkOperations.current)
  useEffect(() => () => forkOperations.current?.retireNavigation(), [])

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
      if (executionRevision.current === undefined && statusRevision === runningRevision.current) setRunning(items.some(row => row.state === "running"))
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

  const pageHistory = useCallback(async (
    workspaceId: string,
    sessionId: string,
    afterSeq: number,
    opening?: { history: HistoryRange; assistantPreview?: AssistantPreview },
  ): Promise<void> => {
    const scope = selection.current
    if (scope.workspaceId !== workspaceId || scope.sessionId !== sessionId) return
    const generation = disconnectRevision.current
    const stillSelected = () => selection.current === scope && disconnectRevision.current === generation
    const request = async (params: HistoryPageRequest) => {
      if (!stillSelected()) throw new Error("History selection changed")
      return bridge.request({
        kind: "session/history", workspaceId, sessionId, afterSeq: params.afterSeq, ...(params.beforeSeq === undefined ? {} : { beforeSeq: params.beforeSeq }), limit: params.limit,
      }) as Promise<HistoryRange>
    }
    try {
      const load = afterSeq === 0
        ? await loadRecentHistory(request, { limit: RECENT_HISTORY_LIMIT, maxEvents: opening ? RECENT_HISTORY_LIMIT : MAX_RETAINED_EVENTS, initialPage: opening?.history })
        : await loadHistory(request, { afterSeq, limit: RECENT_HISTORY_LIMIT, maxPages: HISTORY_MAX_PAGES })
      if (!stillSelected()) return
      setEventWindow((current) => {
        if (!stillSelected()) return current
        const key = JSON.stringify([workspaceId, sessionId])
        const next = applyHistory(current, { events: load.events, nextSeq: load.cursor, ...(afterSeq === 0 ? { startSeq: load.startSeq } : {}) })
        eventWindowCache.set(key, next)
        const baseline = opening?.assistantPreview
        const seeded = baseline && isAssistantPreview(baseline) ? applyNotification(next, baseline) : next
        const preview = assistantPreviews.current.get(key)
        return preview ? applyNotification(seeded, preview) : seeded
      })
      setHistoryLoading(false)
      setHistoryError(undefined)
      if (afterSeq === 0 || !load.exhausted) setHistoryCount((load.startSeq ?? 0) > 0 || !load.exhausted ? load.events.length : undefined)
    } catch (reason) {
      if (stillSelected()) { setHistoryLoading(false); setHistoryError(reason instanceof Error ? reason.message : String(reason)) }
    }
  }, [bridge, eventWindowCache])

  useEffect(() => {
    let active = true
    const navigation = navigationVersion.current
    void Promise.allSettled([refreshWorkspaces(), refreshProjects()])
      .then(([folders, catalog]) => {
        if (!active) return
        if (folders.status === "rejected") {
          setError(folders.reason instanceof Error ? folders.reason.message : String(folders.reason))
          return
        }
        if (navigationVersion.current !== navigation || useUiStore.getState().selectedWorkspaceId !== undefined) return
        const selected = startupWorkspace(folders.value, catalog.status === "fulfilled" ? catalog.value : [])
        setSelectedProjectId(selected.projectId)
        setSelectedWorkspaceId(selected.workspaceId)
      })
    return () => { active = false }
  }, [refreshWorkspaces, refreshProjects, retryNonce, setSelectedWorkspaceId])

  useEffect(() => {
    if (selectedWorkspaceId === undefined) return
    let active = true
    const capabilityScope = workspaceSelection.current
    const lastDisconnect = disconnectRevision.current
    const current = () => active && workspaceSelection.current === capabilityScope && disconnectRevision.current === lastDisconnect
    setCapabilitySnapshot(undefined)
    setSandbox(undefined)
    setError(undefined)
    // A status response only describes the lifecycle observed at the start of this read.
    const observed = workspaceConnections.get(selectedWorkspaceId)
    void bridge.request({ kind: "desktop/runtime/status", workspaceId: selectedWorkspaceId }).then(value => {
      if (!current()) return
      const status = value as { ready?: boolean; generation?: number } | undefined
      if (status?.ready === true && observed?.phase !== "offline" && observed?.phase !== "reconnecting")
        workspaceConnections.setIfCurrent(selectedWorkspaceId, observed, "online", status.generation)
      else if (status?.ready === false && observed?.phase === "online")
        workspaceConnections.setIfCurrent(selectedWorkspaceId, observed, "connecting")
    }).catch(() => undefined)
    // Keep the first selection across failed bootstrap attempts and StrictMode
    // effect replay. A retry may reconcile that restored selection, never a
    // newer selection made by the user after the original attempt started.
    const restoredSelection = restoredSelections.current.get(selectedWorkspaceId) ?? selection.current
    restoredSelections.current.set(selectedWorkspaceId, restoredSelection)
    const dashboardVersion = ++dashboardRequest.current
    const reportFailure = (reason: unknown) => { if (current()) setError(reason instanceof Error ? reason.message : String(reason)) }
    // Capability negotiation enables the selected conversation's owner read.
    // The workspace listing can independently replay large saved histories.
    void bridge.request({ kind: "desktop/capabilities", workspaceId: selectedWorkspaceId }).then(value => {
      if (!current()) return
      const confirmed = (value ?? {}) as Record<string, string[]>
      setCapabilitySnapshot({ workspaceId: selectedWorkspaceId, value: confirmed })
      if (workspaceConnections.get(selectedWorkspaceId)?.phase !== "online")
        workspaceConnections.set(selectedWorkspaceId, "online")
      if (confirmed["desktop-interaction"]?.includes("1")) void interactions.refresh().catch(reportFailure)
    }).catch(reason => {
      if (current() && workspaceConnections.get(selectedWorkspaceId)?.phase !== "online")
        workspaceConnections.set(selectedWorkspaceId, "offline")
      reportFailure(reason)
    })
    void bridge.request({ kind: "workspace/sandbox/state", workspaceId: selectedWorkspaceId }).then(value => {
      if (current()) setSandbox(value as SandboxState | undefined)
    }).catch(reportFailure)
    const opening = {
      bridge, workspace: capabilityScope, generation: lastDisconnect, request: dashboardVersion,
      result: bridge.request({ kind: "session/dashboard", workspaceId: selectedWorkspaceId }),
    }
    openingDashboard.current = opening
    void opening.result.then(value => {
      if (!current() || dashboardVersion < dashboardApplied.current) return
      dashboardApplied.current = dashboardVersion
      const initialDashboard = value as SessionDashboardResult
      setDashboard(initialDashboard)
      if (!reconciledWorkspaces.current.has(selectedWorkspaceId)
        && selection.current === restoredSelection && restoredSelection.sessionId
        && !initialDashboard.listingUnavailable && !initialDashboard.listingPartial
        && !initialDashboard.sessions.some((row) => row.id === restoredSelection.sessionId)) {
        setSelectedSessionId(undefined)
      }
      if (!initialDashboard.listingUnavailable && !initialDashboard.listingPartial) reconciledWorkspaces.current.add(selectedWorkspaceId)
    }).catch(reportFailure)
    return () => {
      active = false
      if (openingDashboard.current === opening) openingDashboard.current = undefined
    }
  }, [bridge, interactions.refresh, retryNonce, selectedWorkspaceId, workspaceConnections])

  useEffect(() => {
    const previews = assistantPreviews.current
    return () => previews.clear()
  }, [bridge])

  // Subscribe BEFORE the first history read (spec §6): a live event that lands
  // during the read must not be lost.
  useEffect(() => {
    if (selectedWorkspaceId === undefined) return
    const scope = selection.current
    const workspace = workspaceSelection.current
    let chunkBuffer: WireEvent[] = []
    let chunkFrame: number | undefined
    const clearChunks = () => {
      if (chunkFrame !== undefined) cancelAnimationFrame(chunkFrame)
      chunkFrame = undefined
      chunkBuffer = []
    }
    const runtimeAvailable = () => workspaceConnections.get(selectedWorkspaceId)?.phase !== "idle"
    const refreshList = createRefreshScheduler(async () => { if (runtimeAvailable()) await refreshDashboard(selectedWorkspaceId) })
    const refreshTurn = selectedSessionId ? createRefreshScheduler(async () => {
      if (runtimeAvailable()) await refreshTasks(selectedWorkspaceId, selectedSessionId)
    }) : undefined
    const refresh = () => { refreshList.schedule(); refreshTurn?.schedule() }
    const handle = (event: DesktopEvent) => {
      if (event.kind === "window/state" || event.kind === "runtime/diagnostic" || event.kind === "runtime/activity") return
      // Notifications for all workspaces arrive on this bridge. Keep unfinished
      // prefixes between selections, and discard previews when their owner retires.
      let preview: AssistantPreview | undefined
      if (event.kind === "sdk/disconnected" || event.kind === "sdk/idle") {
        const prefix = JSON.stringify([event.workspaceId]).slice(0, -1) + ","
        for (const key of assistantPreviews.current.keys()) if (key.startsWith(prefix)) assistantPreviews.current.delete(key)
      } else if (event.kind === "sdk/notification" && event.method === "session/execution-state") {
        const state = event.params as { sessionId?: string; running?: boolean }
        if (state?.running === false && typeof state.sessionId === "string") {
          assistantPreviews.current.delete(JSON.stringify([event.workspaceId, state.sessionId]))
        }
      } else if (event.kind === "sdk/notification" && event.method === "session/event") {
        const params = event.params as { sessionId?: string; event?: WireEvent }
        if (params?.event && typeof params.sessionId === "string") {
          const key = JSON.stringify([event.workspaceId, params.sessionId])
          const previous = assistantPreviews.current.get(key)
          preview = updateAssistantPreview(previous, params.event)
          if (preview !== previous) {
            if (preview) assistantPreviews.current.set(key, preview)
            else assistantPreviews.current.delete(key)
          }
        }
      }
      if (workspaceSelection.current !== workspace || event.workspaceId !== selectedWorkspaceId) return
      if (event.kind === "sdk/ready") {
        setError(undefined)
        if (disconnected.current === workspace) {
          disconnected.current = undefined
          // Reopening fetches the authoritative tail. A concurrent forward
          // replay could splice an older disjoint page back into that window.
          setRetryNonce(value => value + 1)
          executionRevision.current = undefined
          refresh()
        }
        return
      }
      if (event.kind === "sdk/disconnected" || event.kind === "sdk/idle") {
        disconnectRevision.current++
        clearChunks()
        // The new service starts its own execution revisions. Any pending
        // queue read was made by the retiring service.
        executionRevision.current = undefined
        runningRevision.current++
        tasksRequest.current++
        setRunning(false)
        setQueue(rows => rows?.filter(row => row.state !== "running"))
        if (event.kind === "sdk/idle") {
          setHistoryLoading(false)
          return
        }
        disconnected.current = workspace
        setCapabilitySnapshot(undefined)
        setSandbox(undefined)
        setEventWindow((current) => markDisconnected(current))
        return
      }
      // The workspace observer can still be installed for the old session
      // until passive effects run. Its preview updates above remain global.
      if (selection.current !== scope && (event.method === "session/execution-state" || event.method === "session/event" || event.method === "session/status")) return
      if (event.method === "session/execution-state") {
        const state = event.params as Partial<Record<keyof SessionExecutionStateNotification, unknown>> | undefined
        if (!state || typeof state.sessionId !== "string" || typeof state.running !== "boolean"
          || typeof state.queued !== "number" || !Number.isSafeInteger(state.queued) || state.queued < 0
          || typeof state.revision !== "number" || !Number.isSafeInteger(state.revision) || state.revision < 1) return
        if (state.sessionId !== selectedSessionId) { refreshList.schedule(); return }
        if (!runtimeAvailable()) return
        if (executionRevision.current !== undefined && state.revision <= executionRevision.current) return
        executionRevision.current = state.revision
        runningRevision.current++
        // Invalidate queue/task reads started before the authoritative event.
        tasksRequest.current++
        setRunning(state.running)
        refresh()
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
      if (event.method === "desktop/session/navigation/changed") { refreshList.schedule(); return }
      if (event.method !== "session/event" && event.method !== "session/status") return
      const info = classifyNotification(event.method, event.params)
      if (info.kind === "ignore") return
      const record = event.method === "session/event" ? (event.params as { event?: WireEvent }).event : undefined
      if (record) {
        if (isAssistantPreview(record)) {
          if (preview && info.sessionId === selectedSessionId && selection.current === scope) {
            setEventWindow(current => selection.current === scope ? applyNotification(current, preview) : current)
          }
          return
        }
      }
      if (info.sessionId !== selectedSessionId) {
        if (affectsSessionDashboard(event.method, event.params)) refreshList.schedule()
        return
      }
      if (info.kind === "chunk") {
        if (!record) return
        chunkBuffer.push(record)
        if (chunkFrame === undefined) {
          chunkFrame = requestAnimationFrame(() => {
            const buffered = chunkBuffer
            clearChunks()
            if (buffered.length === 0 || selection.current !== scope) return
            setEventWindow(current => selection.current === scope
              ? buffered.reduce((next, item) => applyNotification(next, item), current) : current)
          })
        }
        return
      }
      if (info.kind === "durable") {
        if (record) {
          setEventWindow(current => selection.current === scope ? applyNotification(current, record) : current)
          if ((record.type === "todo/write" || record.type === "goal/change") && workStateSupported.current) void refreshWorkState(selectedWorkspaceId, selectedSessionId)
        }
        refreshTurn?.schedule()
        if (affectsSessionDashboard(event.method, event.params)) refreshList.schedule()
        return
      }
      if (!runtimeAvailable()) return
      runningRevision.current++
      // Legacy transport status describes one request; service state describes
      // every submission, including a following turn already running.
      if (executionRevision.current === undefined) setRunning(info.status === "queued")
      refresh()
    }
    selectedWorkspaceEvents.current = handle
    return () => {
      if (selectedWorkspaceEvents.current === handle) selectedWorkspaceEvents.current = undefined
      refreshList.dispose(); refreshTurn?.dispose(); clearChunks()
    }
  }, [bridge, interactions.update, refreshDashboard, refreshTasks, refreshWorkState, selectedSessionId, selectedWorkspaceId, workspaceConnections])

  // A background runtime can become ready, disconnect or go idle while it is unselected.
  useEffect(() => bridge.onEvent(event => {
    if (workspaceConnections.observe(event)) selectedWorkspaceEvents.current?.(event)
  }), [bridge, workspaceConnections])

  const workStateEnabled = capabilities["desktop-work-state"]?.includes("1") === true
  useEffect(() => {
    if (!workStateEnabled || !selectedWorkspaceId || !selectedSessionId) return
    void refreshWorkState(selectedWorkspaceId, selectedSessionId)
  }, [workStateEnabled, selectedWorkspaceId, selectedSessionId, retryNonce, refreshWorkState])

  useEffect(() => {
    reviewRequest.current++
    setReviewSelected(undefined)
    setReviewDiff(undefined)
    setReviewPreview(undefined)
    setReviewError(undefined)
  }, [bridge, selectedWorkspaceId])

  const selectReview = useCallback(async (path: string, mode: "diff" | "preview"): Promise<void> => {
    if (selectedWorkspaceId === undefined) return
    const scope = workspaceSelection.current
    const request = ++reviewRequest.current
    setReviewError(undefined)
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
    const scope = selection.current
    const generation = disconnectRevision.current
    const stillOpen = () => active && selection.current === scope && generation === disconnectRevision.current
    const selectionKey = JSON.stringify([selectedWorkspaceId, selectedSessionId])
    const cached = eventWindowCache.get(selectionKey)
    const window = cached ?? emptyEventWindow()
    const preview = assistantPreviews.current.get(selectionKey)
    setWindowKey(selectionKey)
    setEventWindow(preview ? applyNotification(window, preview) : window)
    setHistoryLoading(cached === undefined)
    setModel(undefined)
    setQueue(undefined)
    setTasks(undefined)
    setTaskError(undefined)
    setHistoryError(undefined)
    setHistoryCount(undefined)
    if (executionRevision.current === undefined) setRunning(false)
    runningRevision.current++
    setQueueResumable(false)
    // Start every selection read together. Waiting for history before the
    // model/interaction/task reads added their latencies to one another.
    const fail = (reason: unknown) => { if (stillOpen()) setTaskError(reason instanceof Error ? reason.message : String(reason)) }
    type OpenResult = {
      history?: HistoryRange
      historyError?: string
      assistantPreview?: AssistantPreview
    }
    void (async () => {
      const raw = await bridge.request({ kind: "desktop/session/open", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
        .catch(() => undefined)
      const opened = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as OpenResult : undefined
      if (!stillOpen()) return
      const history = Array.isArray(opened?.history?.events) ? opened.history : undefined
      if (history && !requiresHistoryTailProbe(history, RECENT_HISTORY_LIMIT)) {
        setEventWindow((current) => {
          if (!stillOpen()) return current
          const next = applyHistory(current, history)
          eventWindowCache.set(selectionKey, next)
          const baseline = opened?.assistantPreview
          const seeded = baseline && isAssistantPreview(baseline) ? applyNotification(next, baseline) : next
          const live = assistantPreviews.current.get(selectionKey)
          return live ? applyNotification(seeded, live) : seeded
        })
        setHistoryLoading(false)
        if (opened?.historyError) setHistoryError(opened.historyError)
      } else {
        if (opened?.historyError) setHistoryError(opened.historyError)
        await pageHistory(selectedWorkspaceId, selectedSessionId, 0, history ? { history, assistantPreview: opened?.assistantPreview } : undefined)
      }
      if (!stillOpen()) return
      // Warm the session assembly while the user is reading the restored tail;
      // the first prompt then does not pay the lazy assembly cost.
      if (opened) void bridge.request({ kind: "desktop/session/warm", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
        .then((warm: unknown) => { const result = warm as { ready?: boolean; error?: string } | undefined; if (result?.ready === false) console.warn("session warm failed", result.error) })
        .catch((error: unknown) => console.warn("session warm failed", error))
    })().catch(fail)
    const version = ++modelRequest.current
    void bridge.request({ kind: "session/model/state", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
      .then(value => { if (stillOpen() && version === modelRequest.current) setModel(value as SessionModelState) }).catch(fail)
    void interactions.refresh(selectedSessionId).catch(fail)
    return () => { active = false }
  }, [bridge, eventWindowCache, interactions.refresh, pageHistory, retryNonce, selectedSessionId, selectedWorkspaceId])

  // Select the authoritative queue surface only after this workspace has
  // negotiated its capabilities. History loading does not own execution state.
  useEffect(() => {
    if (capabilitiesReady && selectedWorkspaceId && selectedSessionId) void refreshTasks(selectedWorkspaceId, selectedSessionId)
  }, [capabilitiesReady, capabilities, refreshTasks, selectedSessionId, selectedWorkspaceId])

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
  const currentScope = JSON.stringify([selectedWorkspaceId, selectedSessionId])
  const { events, live } = eventWindow
  const historySelection = selection.current
  const historyRevision = disconnectRevision.current
  const historyReadScope = useMemo(() => ({
    isCurrent: () => selection.current === historySelection && disconnectRevision.current === historyRevision,
  }), [historySelection, historyRevision])
  const scrollHistory = useHistoryScroll(historySelection, historyReadScope, windowKey === currentScope ? events : [], eventWindow.cursor, historyRequest)
  const visibleEchoes = useMemo(() => pendingEchoes(optimistic, currentScope, events), [optimistic, currentScope, events])
  useEffect(() => {
    if (visibleEchoes !== optimistic) setOptimistic(current => current === optimistic ? visibleEchoes : current)
  }, [optimistic, visibleEchoes])
  const conversationRows = useMemo(() => {
    const rows = windowKey === currentScope ? projectTimeline(timelineEvents({ events, live })) : []
    for (const echo of visibleEchoes) rows.push({ id: `optimistic:${echo.token}`, kind: "message", role: "user", text: echo.text })
    return rows
  }, [currentScope, events, live, visibleEchoes, windowKey])
  function sendInput(delivery: "queue" | "steer"): ComposerProps["onPrompt"] {
    return async (text, context, images, onAdmitted, captured) => {
      if (!selectedWorkspaceId || !selectedSessionId) throw new Error("No conversation selected")
      const owner = selection.current
      const submission = captured && "delivery" in captured ? captured : captureSessionSubmission(selectedWorkspaceId, selectedSessionId, text, delivery)
      const { token } = submission
      const showEcho = submission.delivery === "queue"
      const ownsEcho = (row: PendingEcho) => row.scope === currentScope && row.token === token
      const removeEcho = () => setOptimistic(current => current.filter(row => !ownsEcho(row)))
      if (showEcho) setOptimistic(current => [...current.filter(row => !ownsEcho(row)), { scope: currentScope, token, text }])
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (projectScopeSupported && !checksProjectOnAdmission) {
          await bridge.request({ kind: "desktop/session/project/state", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId })
            .catch(() => { throw new ComposerPreparationError(t("無法確認會話專案；草稿仍保留。")) })
        }
        if (selection.current === owner) scrollHistory.latest?.()
        timer = setTimeout(() => { if (selection.current === owner) void refreshTasks(selectedWorkspaceId, selectedSessionId) }, 500)
        const accepted = (inputId?: string) => {
          if (showEcho && inputId) setOptimistic(current => current.map(row => ownsEcho(row) ? { ...row, inputId } : row))
          const consume = () => consumeSessionSubmission(selectedWorkspaceId, selectedSessionId, token)
          if (onAdmitted) void onAdmitted(consume)
          else consume()
        }
        await operations.run(selectedWorkspaceId, selectedSessionId, { kind: "prompt", token, text, context, images, delivery: submission.delivery, onAdmitted: accepted })
        if (!usesDurableInput) removeEcho()
      } catch (error) { removeEcho(); throw error }
      finally { clearTimeout(timer) }
      if (selection.current !== owner) return
      if (workspaceConnections.get(selectedWorkspaceId)?.phase === "online")
        void pageHistory(selectedWorkspaceId, selectedSessionId, cursorRef.current)
      void refreshTasks(selectedWorkspaceId, selectedSessionId)
      void refreshDashboard(selectedWorkspaceId)
    }
  }
  const conversation = selectedWorkspaceId === undefined || selectedSessionId === undefined
    ? undefined
    : {
        rows: conversationRows,
        history: scrollHistory.earlier || scrollHistory.viewport || scrollHistory.loading || scrollHistory.error ? scrollHistory : undefined,
        assistantPreview: windowKey === currentScope && eventWindow.assistantPreview?.offset === 0 ? eventWindow.assistantPreview : undefined,
        loading: historyLoading,
        canSend: gate.canSend && projectReady && !(operation?.busy && operation.kind !== "prompt"),
        projectReady,
        sendReason: !projectReady ? currentBinding?.error ?? t("正在套用專案資料夾…") : operation?.kind === "compact" && operation.busy ? t("正在壓縮上下文") : gate.reason,
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
          const result = await operations.run(selectedWorkspaceId, selectedSessionId, { kind: "compact", instructions })
          if (selection.current === scope && (result?.outcome === 'blocked' || result?.outcome === 'reduced-over-target')) setTaskActionFailure({ scope, message: [result.outcome === 'reduced-over-target' ? t('壓縮後的完整請求仍超過目標。') : t('壓縮未完成。'), safeCompactionBlockedReason(result.blockedReason)].filter(Boolean).join(' ') })
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
        onSteer: sendInput("steer"),
        tasks,
        workState: workStateResult?.scope === selection.current ? workStateResult.view : undefined,
        workStateError: workStateFailure?.scope === selection.current ? workStateFailure.message : undefined,
        onRetryWorkState: () => { void refreshWorkState(selectedWorkspaceId, selectedSessionId) },
        onReloadSession: async () => {
          const scope = selection.current
          if (!scope.workspaceId || !scope.sessionId) return
          try {
            await bridge.request({ kind: "desktop/session/reload", workspaceId: scope.workspaceId, sessionId: scope.sessionId })
            await refreshWorkState(scope.workspaceId, scope.sessionId)
          } catch (reason) {
            setWorkStateFailure({ scope, message: reason instanceof Error ? reason.message : String(reason) })
          }
        },
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
        onPrompt: sendInput("queue"),
        onCancel: async () => {
          const scope = selection.current
          try {
            let result = await bridge.request({ kind: "session/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }) as { cancelled?: boolean; reason?: string }
            // Draft sessions created through durable input are not in the
            // server's prompt-flight registry. Abort their running input row.
            if (result?.cancelled !== true && result?.reason === "not-found") {
              const running = queue?.find(row => row.state === "running")
              if (running) result = await bridge.request({ kind: "desktop/session/input/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, inputId: running.id }) as { cancelled?: boolean; reason?: string }
            }
            if (selection.current === scope) { setTaskActionFailure(undefined); await refreshTasks(selectedWorkspaceId, selectedSessionId) }
          } catch (reason) {
            if (selection.current === scope) setTaskActionFailure({ scope, message: reason instanceof Error ? reason.message : String(reason) })
          }
        },
        onCancelTask: (taskId: string) => {
          const scope = selection.current
          void bridge.request({ kind: "session/tasks/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, id: taskId })
            .then(() => { if (selection.current === scope) setTaskActionFailure(undefined); return refreshTasks(selectedWorkspaceId, selectedSessionId) })
            .catch((reason: unknown) => { if (selection.current === scope) setTaskActionFailure({ scope, message: reason instanceof Error ? reason.message : String(reason) }) })
        },
        onCancelQueue: (queueId: string) => {
          const scope = selection.current
          void (async () => {
            const primary = durableInputSupported.current
              ? await bridge.request({ kind: "desktop/session/input/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, inputId: queueId })
              : await bridge.request({ kind: "session/queue/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, id: queueId })
            let cancelled = (primary as { cancelled?: boolean } | undefined)?.cancelled !== false
            // Durable input and the M49 queue project different ids for some
            // service-front rows. The durable answer can be true while the
            // lane projection still lists the row, so always offer the lane
            // cancel once and let a true answer drive the optimistic cleanup.
            if (durableInputSupported.current) {
              const fallback = await bridge.request({ kind: "session/queue/cancel", workspaceId: selectedWorkspaceId, sessionId: selectedSessionId, id: queueId }).catch(() => undefined) as { cancelled?: boolean } | undefined
              if (fallback?.cancelled === true) cancelled = true
            }
            if (cancelled) setOptimistic(current => current.filter(row => row.scope !== currentScope || row.inputId !== queueId))
            if (selection.current === scope) setTaskActionFailure(undefined)
            return refreshTasks(selectedWorkspaceId, selectedSessionId)
          })().catch((reason: unknown) => { if (selection.current === scope) setTaskActionFailure({ scope, message: reason instanceof Error ? reason.message : String(reason) }) })
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
          // Deferral keeps the gateway's interrupted card. Only a final answer
          // closes it; a later cancel/expiry notification still owns removal.
          if (!(decision.kind === "question" && "deferred" in decision)) interactions.update(requestId)
          void refreshTasks(selectedWorkspaceId, sessionId)
        },
      }

  return (<>
    <Workbench
      onSandboxChange={(mode) => { if (selectedWorkspaceId === workspaceSelection.current.workspaceId) setSandbox({ mode, source: "settings", wired: true }) }}
      bridge={bridge}
      workspaces={workspaces}
      projects={projects}
      selectedProjectId={activeProjectId}
      projectContext={selectedSessionId
        ? !capabilitiesReady ? { status: "loading" }
          : !projectScopeSupported || projectError || currentBinding?.error ? { status: "unavailable" }
          : !selectedBinding || projects === undefined ? { status: "loading" }
          : { status: "ready", projectId: selectedBinding.projectId, projectName: projects.find(project => project.id === selectedBinding.projectId)?.name }
        : projects === undefined ? { status: projectError ? "unavailable" : "loading" }
          : { status: "ready", projectId: activeProjectId, projectName: projects.find(project => project.id === activeProjectId)?.name }}
      onProjectsChanged={async () => { await Promise.all([refreshProjects(), refreshWorkspaces()]) }}
      onSelectProject={(id) => {
        navigationVersion.current++
        setSelectedProjectId(id)
        const project = projects?.find((row) => row.id === id)
        const workspaceId = project && projectWorkspace(project, workspaces)
        if (workspaceId !== selection.current.workspaceId) setDashboard(undefined)
        setSelectedWorkspaceId(workspaceId); setSelectedSessionId(undefined)
        useUiStore.getState().setSurface(workspaceId ? "conversation" : "projects")
      }}
      onSelectSessionInWorkspace={(workspaceId, sessionId, projectId) => {
        navigationVersion.current++
        setHistoryTarget(undefined)
        if (workspaceId !== selection.current.workspaceId) setDashboard(undefined)
        setSelectedProjectId(projectId)
        setSelectedWorkspaceId(workspaceId); setSelectedSessionId(sessionId)
      }}
      onManageSessionInWorkspace={async (workspaceId, sessionId, action, title) => {
        if (action === 'fork' || action === 'fork-fresh') {
          await forkCallbacks.current!.inWorkspace(workspaceId, sessionId, action); return
        }
        await bridge.request({ kind: "desktop/session/manage", workspaceId, sessionId, action, ...(title !== undefined ? { title } : {}) })
        if (selection.current.workspaceId === workspaceId) {
          await refreshDashboard(workspaceId)
          if (action === "archive" && selection.current.workspaceId === workspaceId && selection.current.sessionId === sessionId) setSelectedSessionId(undefined)
        }
      }}
      dashboard={dashboard}
      readOpeningDashboard={readOpeningDashboard}
      attentionBySession={pending.reduce<Record<string, number>>((counts, row) => { counts[row.sessionId] = (counts[row.sessionId] ?? 0) + 1; return counts }, {})}
      capabilities={capabilities}
      capabilitiesReady={capabilitiesReady}
      sandbox={sandbox}
      error={(connection === "online" || connection === "idle") && /SdkConnectionError|sdk subprocess exited|sdk-connection/i.test(error ?? projectError ?? "") ? undefined : error ?? projectError}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedSessionId={selectedSessionId}
      connection={selectedWorkspaceId ? connection : undefined}
      conversation={conversation}
      onSelectHistory={(target) => {
        const scope = selection.current
        const version = ++navigationVersion.current
        const surface = historySurfaceRevision.current
        const current = () => historyReadScope.isCurrent() && navigationVersion.current === version
          && historySurfaceRevision.current === surface
        if (!current()) return
        if (!Number.isSafeInteger(target.seq) || target.seq < 0) { setError("Invalid history position"); return }
        void bridge.request({ kind: "desktop/notifications/target", workspaceId: target.workspaceId, sessionId: target.sessionId }).then(value => {
          if (!current()) return
          const validated = value as { workspaceId: string; sessionId: string; projectId?: string }
          if (validated.workspaceId !== target.workspaceId || validated.sessionId !== target.sessionId) throw new Error("Invalid history target")
          if (target.workspaceId !== scope.workspaceId) setDashboard(undefined)
          setSelectedProjectId(validated.projectId); setHistoryTarget({ ...target }); setSelectedWorkspaceId(target.workspaceId); setSelectedSessionId(target.sessionId)
          useUiStore.getState().setSurface("conversation")
        }).catch(reason => { if (current()) setError(String(reason)) })
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
      historicalView={historyTarget && historyTarget.workspaceId === selectedWorkspaceId && historyTarget.sessionId === selectedSessionId ? {
        selection: historyTarget, request: historyRequest, readScope: historyReadScope,
        onLatest: () => { navigationVersion.current++; scrollHistory.latest?.(); setHistoryTarget(undefined) },
        onForkAt: capabilities["session-fork-bootstrap"]?.includes("1") ? async target => {
          const scope = selection.current
          if (scope.workspaceId !== target.workspaceId || scope.sessionId !== target.sessionId) return
          await forkOperations.current!.run(target.workspaceId, target.sessionId, target.seq)
        } : undefined,
      } : undefined}
      review={{
        projectFiles: selectedWorkspaceId && capabilities["desktop-project-files"]?.includes("1") ? { selection: { workspaceId: selectedWorkspaceId, ...(selectedSessionId ? { sessionId: selectedSessionId } : {}), ...(selectedBinding?.projectId ? { projectId: selectedBinding.projectId } : activeProjectId ? { projectId: activeProjectId } : {}) }, request: projectFileRequest, openFile: projectOpenFile, externalOpenFile } : undefined,
        onSaveFile: async (path, text, expectedRevision) => {
          if (!selectedWorkspaceId) throw new Error("No workspace selected")
          return await bridge.request({ kind: "desktop/review/file/save", workspaceId: selectedWorkspaceId, path, text, expectedRevision }) as import("./review/SourceFileEditor.tsx").ReviewSaveResult
        },
        error: reviewError,
        selected: reviewSelected,
        diff: reviewDiff,
        preview: reviewPreview,
        onSelect: (path, mode) => { void selectReview(path, mode) },
        onRefresh: () => {
          if (!selectedWorkspaceId || !reviewSelected) return
          const { path, mode } = reviewSelected
          if (mode === "preview") { void selectReview(path, mode); return }
          const scope = workspaceSelection.current
          const ticket = ++reviewRequest.current
          void bridge.request({ kind: "desktop/review/changes", workspaceId: selectedWorkspaceId }).then(value => {
            const changes = value as ReviewChanges
            if (workspaceSelection.current !== scope || reviewRequest.current !== ticket) return
            if (changes.kind === "ok" && changes.files.some(file => file.path === path && file.canDiff)) {
              void selectReview(path, mode)
              return
            }
            setReviewError(undefined)
            setReviewSelected(undefined)
            setReviewDiff(undefined)
            setReviewPreview(undefined)
          }).catch(reason => {
            if (workspaceSelection.current === scope && reviewRequest.current === ticket) setReviewError(reason instanceof Error ? reason.message : String(reason))
          })
        },
      }}
      onSelectWorkspace={(workspaceId, projectId) => {
        navigationVersion.current++
        setHistoryTarget(undefined)
        setSelectedProjectId(projectId)
        if (workspaceId !== selectedWorkspaceId) {
          setSelectedWorkspaceId(workspaceId)
          setDashboard(undefined)
        }
        setSelectedSessionId(undefined)
      }}
      onSelectSession={(id) => { navigationVersion.current++; setHistoryTarget(undefined); setSelectedSessionId(id) }}
      onRewindComplete={(workspaceId, sessionId) => {
        if (selection.current.workspaceId !== workspaceId) return
        void refreshDashboard(workspaceId)
        if (selection.current.sessionId === sessionId) setRetryNonce((value) => value + 1)
      }}
      onManageSession={async (sessionId, action, title) => {
        if (!selectedWorkspaceId) return
        if (action === 'fork' || action === 'fork-fresh') {
          await forkCallbacks.current!.inSelection(selectedWorkspaceId, sessionId, action); return
        }
        const scope = selection.current
        await bridge.request({ kind: "desktop/session/manage", workspaceId: selectedWorkspaceId, sessionId, action, ...(title !== undefined ? { title } : {}) })
        await refreshDashboard(selectedWorkspaceId)
        if (selection.current !== scope) return
        if (action === "archive" && selectedSessionId === sessionId) setSelectedSessionId(undefined)
      }}
      onRetry={() => {
        forkOperations.current!.retireNavigation()
        setError(undefined)
        if (selectedWorkspaceId === undefined) { setRetryNonce(current => current + 1); return }
        const reconnecting = workspaceConnections.set(selectedWorkspaceId, "reconnecting")
        const recoveryScope = workspaceSelection.current, recoveryNonce = retryNonce
        void bridge.request({ kind: 'desktop/runtime/recover', workspaceId: selectedWorkspaceId }).then(
          () => { if (workspaceSelection.current === recoveryScope) setRetryNonce(current => current === recoveryNonce ? current + 1 : current) },
          reason => { if (workspaceSelection.current === recoveryScope && workspaceConnections.get(selectedWorkspaceId) === reconnecting) {
            workspaceConnections.setIfCurrent(selectedWorkspaceId, reconnecting, "offline")
            setError(reason instanceof Error ? reason.message : String(reason))
          } },
        )
      }}
      onSessionsChanged={(createdWorkspaceId) => {
        if (createdWorkspaceId) void refreshWorkspaces().catch(() => {})
        if (selectedWorkspaceId !== undefined) void forkOperations.current!.refresh(selectedWorkspaceId)
      }}
    />
    <RuntimeFeedback bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} onOpenLog={useUiStore.getState().openRuntimeLog} />
    </>
  )
}
