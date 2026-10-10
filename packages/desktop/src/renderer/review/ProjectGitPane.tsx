import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { ProjectEntry } from "../../main/projects.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge, DesktopRequest } from "../../shared/bridge.ts"
import { useLocale } from "../design/i18n.ts"
import { ReviewPane, type ReviewChanges, type ReviewCommitResult, type ReviewGitResult, type ReviewText } from "./ReviewPane.tsx"
import "./project-git.css"

export interface ProjectGitPaneProps {
  bridge: DesktopBridge
  project: ProjectEntry
  workspaces: WorkspaceEntry[]
  onBusyChange?(busy: boolean): void
}

interface NativeScope { project: ProjectEntry; members: WorkspaceEntry[]; revision: string }
interface Target { bridge: DesktopBridge; projectId: string; propsKey: string; scopeKey: string; identity: string; workspaceId: string; path: string }
interface Selection { identity: string; path: string; mode: "diff" | "preview"; nonce: number }
interface ChangesState { identity: string; revision: number; value?: ReviewChanges; error?: string }
interface MutationLock {
  pending: boolean
  subscribe(listener: () => void): () => void
  snapshot(): boolean
  set(value: boolean): void
}
// A dialog remount must not admit a second operation while its first native
// request is still running. Drafts and locks have the same connection owner.
const locks = new WeakMap<DesktopBridge, Map<string, MutationLock>>()
function lockFor(bridge: DesktopBridge, projectId: string): MutationLock {
  let projects = locks.get(bridge)
  if (!projects) { projects = new Map(); locks.set(bridge, projects) }
  let lock = projects.get(projectId)
  if (!lock) {
    const listeners = new Set<() => void>()
    lock = {
      pending: false,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      snapshot: () => lock!.pending,
      set: value => { lock!.pending = value; for (const listener of listeners) listener() },
    }
    projects.set(projectId, lock)
  }
  return lock
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value)

function checkedNativeScope(projects: unknown, workspaces: unknown, projectId: string, invalid: string, removed: string): NativeScope {
  if (!Array.isArray(projects) || !Array.isArray(workspaces)
    || !projects.every(row => record(row) && nonempty(row.id) && typeof row.name === "string"
      && Array.isArray(row.workspaceIds) && row.workspaceIds.every(nonempty) && new Set(row.workspaceIds).size === row.workspaceIds.length
      && (row.primaryWorkspaceId === undefined || nonempty(row.primaryWorkspaceId) && row.workspaceIds.includes(row.primaryWorkspaceId))
      && nonempty(row.createdAt) && nonempty(row.updatedAt))
    || !workspaces.every(row => record(row) && nonempty(row.id) && nonempty(row.path) && typeof row.label === "string")
    || new Set(projects.map(row => row.id)).size !== projects.length || new Set(workspaces.map(row => row.id)).size !== workspaces.length) throw new Error(invalid)
  const project = (projects as ProjectEntry[]).find(row => row.id === projectId)
  if (!project) throw new Error(removed)
  const members = project.workspaceIds.map(id => (workspaces as WorkspaceEntry[]).find(row => row.id === id))
  if (members.some(row => !row)) throw new Error(invalid)
  const knownMembers = members as WorkspaceEntry[]
  return { project, members: knownMembers, revision: JSON.stringify([project.workspaceIds, project.primaryWorkspaceId, knownMembers.map(row => [row.id, row.path])]) }
}
function checkedChanges(value: unknown, invalid: string): ReviewChanges {
  if (record(value) && value.kind === "unavailable" && nonempty(value.reason)) return value as unknown as ReviewChanges
  if (!record(value) || value.kind !== "ok" || typeof value.truncated !== "boolean" || !Array.isArray(value.files)
    || !value.files.every(row => record(row) && nonempty(row.path) && ["modified", "added", "deleted", "untracked", "renamed"].includes(String(row.status))
      && typeof row.canDiff === "boolean" && typeof row.canPreview === "boolean"
      && (row.staged === undefined || typeof row.staged === "boolean") && (row.unstaged === undefined || typeof row.unstaged === "boolean"))
    || new Set(value.files.map(row => row.path)).size !== value.files.length) throw new Error(invalid)
  return value as unknown as ReviewChanges
}
function checkedText(value: unknown, invalid: string): ReviewText {
  if (record(value) && value.kind === "unavailable" && nonempty(value.reason)) return value as unknown as ReviewText
  if (!record(value) || value.kind !== "text" || typeof value.text !== "string" || typeof value.truncated !== "boolean"
    || typeof value.bytes !== "number" || !Number.isFinite(value.bytes) || value.bytes < 0) throw new Error(invalid)
  return value as unknown as ReviewText
}
function checkedMutation(value: unknown, commit: boolean, invalid: string): ReviewGitResult | ReviewCommitResult {
  if (record(value) && value.kind === "unavailable" && nonempty(value.reason)) return { kind: "unavailable", reason: value.reason }
  if (record(value) && (commit ? value.kind === "committed" && nonempty(value.commit) : value.kind === "ok")) return value as ReviewGitResult | ReviewCommitResult
  throw new Error(invalid)
}

export function ProjectGitPane({ bridge, project, workspaces, onBusyChange }: ProjectGitPaneProps) {
  const english = useLocale(state => state.locale) === "en"
  const copy = (zh: string, en: string) => english ? en : zh
  const propsKey = JSON.stringify([project.id, project.updatedAt, project.workspaceIds, project.primaryWorkspaceId, workspaces.map(row => [row.id, row.path])])
  const [native, setNative] = useState<{ bridge: DesktopBridge; key: string; scope?: NativeScope; error?: string }>()
  const [membershipRefresh, setMembershipRefresh] = useState(0)
  const [choice, setChoice] = useState<{ projectId: string; workspaceId: string }>()
  const [changes, setChanges] = useState<ChangesState>()
  const [selection, setSelection] = useState<Selection>()
  const [detail, setDetail] = useState<{ identity: string; nonce: number; revision: number; value: ReviewText }>()
  const lock = useMemo(() => lockFor(bridge, project.id), [bridge, project.id])
  const busy = useSyncExternalStore(lock.subscribe, lock.snapshot, lock.snapshot)
  const ownedMutation = useRef<MutationLock | undefined>(undefined)
  const previousBusy = useRef({ lock, busy })
  const currentNative = native?.bridge === bridge && native.key === propsKey ? native : undefined
  const scope = currentNative?.scope
  const members = scope?.members ?? []
  const selectedId = choice?.projectId === project.id && members.some(row => row.id === choice.workspaceId)
    ? choice.workspaceId : scope?.project.primaryWorkspaceId ?? members[0]?.id
  const member = members.find(row => row.id === selectedId)
  const scopeKey = JSON.stringify([project.id, member?.id])
  const identity = JSON.stringify([propsKey, scopeKey, scope?.revision, membershipRefresh])
  const current = useRef({ bridge, projectId: project.id, propsKey, identity, member, membershipRefresh })
  current.current = { bridge, projectId: project.id, propsKey, identity, member, membershipRefresh }
  const mounted = useRef(true), membershipVersion = useRef(0), changesVersion = useRef(0), detailVersion = useRef(0)
  const changesOwner = useRef<string | undefined>(undefined)
  const selectionRef = useRef(selection); selectionRef.current = selection
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange
  const skipAcknowledgedRefresh = useRef<string | undefined>(undefined)
  const target: Target | undefined = member ? { bridge, projectId: project.id, propsKey, scopeKey, identity, workspaceId: member.id, path: member.path } : undefined
  const isCurrent = (captured: Target) => mounted.current && current.current.bridge === captured.bridge && current.current.identity === captured.identity
  const ownsMembership = (captured: Target, ticket: number) => mounted.current && current.current.bridge === captured.bridge && current.current.propsKey === captured.propsKey && ticket === membershipVersion.current
  const visible = changes?.identity === identity ? changes : undefined
  const selected = visible?.value?.kind === "ok" && selection?.identity === identity
    && visible.value.files.some(row => row.path === selection.path) ? selection : undefined
  const selectedDetail = detail?.identity === identity && detail.nonce === selected?.nonce && detail.revision === visible?.revision ? detail.value : undefined

  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; busyCallback.current?.(false) } }, [])
  useEffect(() => {
    const previous = previousBusy.current
    previousBusy.current = { lock, busy }
    if (previous.lock === lock && previous.busy && !busy) {
      if (ownedMutation.current === lock) ownedMutation.current = undefined
      // A remounted dialog did not receive the first instance's readback.
      // Revalidate and read its current scope before exposing Git actions.
      else void refreshMembership()
    }
  }, [lock, busy])

  async function readScope(capturedBridge: DesktopBridge, projectId: string): Promise<NativeScope> {
    const [projects, folders] = await Promise.all([capturedBridge.request({ kind: "projects/list" }), capturedBridge.request({ kind: "workspace/list" })])
    return checkedNativeScope(projects, folders, projectId, copy("無法確認專案資料夾，請重新整理。", "Could not verify project folders. Refresh to retry."), copy("此專案已移除，Git 操作不可用。", "This project was removed. Git actions are unavailable."))
  }
  async function refreshMembership() {
    const ticket = ++membershipVersion.current
    const captured = { bridge, propsKey, projectId: project.id }
    setNative({ bridge, key: propsKey })
    try {
      const scope = await readScope(bridge, project.id)
      if (mounted.current && ticket === membershipVersion.current && current.current.bridge === captured.bridge && current.current.propsKey === captured.propsKey) {
        setNative({ bridge: captured.bridge, key: captured.propsKey, scope })
        // React may batch the loading and resolved membership states. A fresh
        // read must still replace Git status when membership itself is equal.
        setMembershipRefresh(ticket)
      }
    } catch (error) {
      if (mounted.current && ticket === membershipVersion.current && current.current.bridge === captured.bridge && current.current.propsKey === captured.propsKey) setNative({ bridge: captured.bridge, key: captured.propsKey, error: errorText(error) })
    }
  }
  useEffect(() => {
    void refreshMembership()
    return () => { membershipVersion.current++ }
  }, [bridge, propsKey])
  useEffect(() => bridge.onEvent(event => {
    if (event.kind === "sdk/notification" && event.method === "desktop/session/navigation/changed") void refreshMembership()
  }), [bridge, propsKey])

  async function readChanges(captured: Target) {
    // A completed action still reads its original repository after navigation.
    // That obsolete read must not invalidate the new project's active request.
    const ticket = isCurrent(captured) ? ++changesVersion.current : undefined
    if (ticket !== undefined) { changesOwner.current = captured.identity; detailVersion.current++; setChanges({ identity: captured.identity, revision: ticket }) }
    try {
      const value = checkedChanges(await captured.bridge.request({ kind: "desktop/review/changes", workspaceId: captured.workspaceId }), copy("Git 變更回應無效，請重新整理。", "Invalid Git changes response. Refresh to retry."))
      if (ticket !== undefined && isCurrent(captured) && ticket === changesVersion.current) setChanges({ identity: captured.identity, revision: ticket, value })
    } catch (error) {
      if (ticket !== undefined && isCurrent(captured) && ticket === changesVersion.current) setChanges({ identity: captured.identity, revision: ticket, error: errorText(error) })
    }
  }
  async function readActionChanges(captured: Target, after: NativeScope, membershipTicket: number) {
    const publishMembership = ownsMembership(captured, membershipTicket)
    if (publishMembership) setNative({ bridge: captured.bridge, key: captured.propsKey, scope: after })
    if (!after.members.some(row => row.id === captured.workspaceId && row.path === captured.path)) return
    const sameMember = () => mounted.current && current.current.bridge === captured.bridge && current.current.projectId === captured.projectId
      && current.current.member?.id === captured.workspaceId && current.current.member.path === captured.path
    if (!sameMember()) { await readChanges(captured); return }
    const view = current.current
    // Membership can change the display identity without changing the action's
    // repository. Bind only its readback to that validated member's new scope.
    // Publish native membership and the matching loading state together so the
    // identity effect cannot start an unawaited competing status read.
    const readbackIdentity = publishMembership
      ? JSON.stringify([view.propsKey, captured.scopeKey, after.revision, view.membershipRefresh]) : view.identity
    const revision = ++changesVersion.current
    changesOwner.current = readbackIdentity
    detailVersion.current++
    setChanges({ identity: readbackIdentity, revision })
    const canPublish = () => revision === changesVersion.current && sameMember() && current.current.propsKey === view.propsKey
      && (publishMembership ? ownsMembership(captured, membershipTicket) : current.current.identity === readbackIdentity)
    try {
      const value = checkedChanges(await captured.bridge.request({ kind: "desktop/review/changes", workspaceId: captured.workspaceId }), copy("Git 變更回應無效，請重新整理。", "Invalid Git changes response. Refresh to retry."))
      if (canPublish()) setChanges({ identity: readbackIdentity, revision, value })
    } catch (error) {
      if (canPublish()) setChanges({ identity: readbackIdentity, revision, error: errorText(error) })
    }
  }
  useEffect(() => {
    if (target && changes?.identity !== identity) void readChanges(target)
    return () => { if (changesOwner.current === identity) changesVersion.current++; detailVersion.current++ }
  }, [bridge, identity])
  useEffect(() => {
    if (!target || !selected) return
    const captured = target, ticket = ++detailVersion.current, nonce = selected.nonce, revision = visible!.revision
    const request: DesktopRequest = { kind: selected.mode === "diff" ? "desktop/review/diff" : "desktop/review/file", workspaceId: captured.workspaceId, path: selected.path }
    void captured.bridge.request(request).then(value => {
      const checked = checkedText(value, copy("Git 檔案回應無效。", "Invalid Git file response."))
      if (isCurrent(captured) && ticket === detailVersion.current) setDetail({ identity: captured.identity, nonce, revision, value: checked })
    }).catch(error => {
      if (isCurrent(captured) && ticket === detailVersion.current) setDetail({ identity: captured.identity, nonce, revision, value: { kind: "unavailable", reason: errorText(error) } })
    })
    return () => { detailVersion.current++ }
  }, [bridge, identity, selected?.nonce, visible?.revision])

  function select(path: string, mode: "diff" | "preview") {
    if (!target || lock.pending || visible?.value?.kind !== "ok") return
    const row = visible.value.files.find(row => row.path === path)
    if (!row || (mode === "diff" ? !row.canDiff : !row.canPreview)) return
    setSelection({ identity, path, mode, nonce: (selectionRef.current?.nonce ?? 0) + 1 })
  }
  function refresh(captured: Target) {
    // ReviewPane requests refresh after a successful action. The native wrapper
    // has already awaited that readback, including keeping the dialog locked.
    if (skipAcknowledgedRefresh.current === captured.identity) { skipAcknowledgedRefresh.current = undefined; return }
    if (!lock.pending && isCurrent(captured)) void refreshMembership()
  }
  async function mutate(captured: Target, request: DesktopRequest, commit = false): Promise<ReviewGitResult | ReviewCommitResult> {
    if (lock.pending || !isCurrent(captured) || visible?.value?.kind !== "ok") return { kind: "unavailable", reason: "operation-pending" }
    ownedMutation.current = lock
    setChoice({ projectId: captured.projectId, workspaceId: captured.workspaceId })
    lock.set(true)
    const ticket = ++membershipVersion.current
    try {
      let authoritative: NativeScope
      try { authoritative = await readScope(captured.bridge, captured.projectId) }
      catch (error) {
        if (ownsMembership(captured, ticket)) setNative({ bridge: captured.bridge, key: captured.propsKey, error: errorText(error) })
        throw error
      }
      if (ownsMembership(captured, ticket)) setNative({ bridge: captured.bridge, key: captured.propsKey, scope: authoritative })
      if (!authoritative.members.some(row => row.id === captured.workspaceId && row.path === captured.path)
        || current.current.projectId === captured.projectId && ticket !== membershipVersion.current) throw new Error(copy("此資料夾已不屬於專案，Git 操作已取消。", "This folder is no longer a project member. The Git action was cancelled."))
      const result = checkedMutation(await captured.bridge.request(request), commit, copy("Git 操作回應無效。", "Invalid Git action response."))
      if (result.kind === "unavailable") {
        if (isCurrent(captured)) setChanges(previous => previous?.identity === captured.identity ? { ...previous, error: result.reason } : previous)
        return result
      }
      // Successful commits still acknowledge their original draft when the
      // view changes or readback fails; they must not become a retryable commit.
      try {
        const after = await readScope(captured.bridge, captured.projectId)
        await readActionChanges(captured, after, ticket)
      } catch (error) {
        if (ownsMembership(captured, ticket)) setNative({ bridge: captured.bridge, key: captured.propsKey, error: errorText(error) })
      }
      skipAcknowledgedRefresh.current = captured.identity
      return result
    } finally { lock.set(false) }
  }

  return <section className="project-git-pane" aria-label={copy("專案 Git", "Project Git")} aria-busy={busy}>
    <header className="project-git-context">
      <div><strong>{scope?.project.name ?? project.name}</strong><p>{copy("檢視專案儲存庫的目前變更；提交只包含已暫存的檔案。", "Review the project's current repository changes. Commits include staged files only.")}</p></div>
      <label>{copy("儲存庫資料夾", "Repository folder")}<select value={member?.id ?? ""} disabled={busy || members.length === 0} onChange={event => { if (!lock.pending && members.some(row => row.id === event.target.value)) setChoice({ projectId: project.id, workspaceId: event.target.value }) }}>
        {members.length === 0 ? <option value="">{copy("等待確認專案資料夾…", "Verifying project folders…")}</option> : members.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
      </select></label>
    </header>
    {member ? <p className="project-git-path" title={member.path}>{member.path}</p> : null}
    {currentNative?.error ? <><p role="alert" className="notice error-text">{currentNative.error}</p><button type="button" disabled={busy} onClick={() => void refreshMembership()}>{copy("重新整理", "Refresh")}</button></> : null}
    {!scope && !currentNative?.error ? <p role="status" className="muted">{copy("正在確認專案資料夾…", "Verifying project folders…")}</p> : null}
    {scope && members.length === 0 ? <p className="notice">{copy("此專案沒有可用的資料夾。", "This project has no available folders.")}</p> : null}
    {target ? <fieldset className="project-git-review" disabled={busy}>
      {visible?.error ? <p role="alert" className="notice error-text">{visible.error}</p> : null}
      <ReviewPane title="Git" draftOwner={bridge} workspaceId={target.workspaceId} draftKey={target.scopeKey} changes={visible?.value} error={visible?.error} selected={selected} diff={selected?.mode === "diff" ? selectedDetail : undefined} preview={selected?.mode === "preview" ? selectedDetail : undefined}
        onSelect={select} onRefresh={() => refresh(target)}
        onStage={path => mutate(target, { kind: "desktop/review/stage", workspaceId: target.workspaceId, path }) as Promise<ReviewGitResult>}
        onUnstage={path => mutate(target, { kind: "desktop/review/unstage", workspaceId: target.workspaceId, path }) as Promise<ReviewGitResult>}
        onCommit={message => mutate(target, { kind: "desktop/review/commit", workspaceId: target.workspaceId, message }, true) as Promise<ReviewCommitResult>} />
    </fieldset> : null}
  </section>
}
