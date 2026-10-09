import { useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale, useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { RewindPanel } from "./RewindPanel.tsx"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
export type ManageSession = (sessionId: string, action: "rename" | "archive" | "restore" | "fork" | "pin" | "unpin" | "read" | "unread", title?: string) => Promise<void>
interface Row { id: string; title?: string }
export interface ManageSessionBatchCommand { action: "archive" | "restore" | "delete" | "move"; sessionIds: string[]; projectId?: string; expectedOwners?: Record<string, string | null> }
export interface ManageSessionBatchResult { results: ({ sessionId: string; ok: true; projectId?: string; executionWorkspace?: string } | { sessionId: string; ok: false; error: string; sessionDeleted?: boolean })[] }
export interface SessionManagerProps {
  bridge: DesktopBridge; workspaceId: string; onManage: ManageSession; onRewindComplete?: (sessionId: string) => void; initialArchived?: boolean
  onBatch?(command: ManageSessionBatchCommand): Promise<ManageSessionBatchResult>
  projects?: { id: string; name: string }[]
  currentOwners?: Record<string, string | undefined>
  executionWorkspace?: string
  initialSelected?: string[]
  onBusyChange?(busy: boolean): void
}
export function SessionManager({ bridge, workspaceId, onManage, onRewindComplete, initialArchived = false, onBatch, projects, currentOwners, executionWorkspace, initialSelected = [], onBusyChange }: SessionManagerProps) {
  const t = useText()
  const english = useLocale(state => state.locale) === "en"
  const c = (zh: string, en: string) => english ? en : zh
  const [archived, setArchived] = useState(initialArchived)
  const [rows, setRows] = useState<Row[]>()
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [editing, setEditing] = useState<string>()
  const [title, setTitle] = useState("")
  const [confirm, setConfirm] = useState<string>()
  const [rewinding, setRewinding] = useState<string>()
  const [selected, setSelected] = useState(new Set(initialSelected))
  const [batchConfirmation, setBatchConfirmation] = useState<ManageSessionBatchCommand>()
  const [batchResults, setBatchResults] = useState<ManageSessionBatchResult>()
  const [destination, setDestination] = useState("")
  const [page, setPage] = useState(0)
  const [rewindBusy, setRewindBusy] = useState(false)
  const blocked = busy || rewindBusy
  const busyListener = useRef(onBusyChange)
  busyListener.current = onBusyChange
  useEffect(() => { busyListener.current?.(busy || rewindBusy) }, [busy, rewindBusy])
  useEffect(() => () => { busyListener.current?.(false) }, [])
  const initialSelectionKey = JSON.stringify(initialSelected)
  const scope = useRef(workspaceId)
  scope.current = workspaceId
  useEffect(() => { setSelected(new Set(initialSelected)); setBatchConfirmation(undefined); setBatchResults(undefined); setPage(0) }, [workspaceId, archived, initialSelectionKey])
  useEffect(() => {
    let active = true
    setRows(undefined); setError(undefined); setEditing(undefined); setConfirm(undefined)
    void bridge.request({ kind: archived ? "desktop/session/archived" : "session/list", workspaceId }).then((value) => {
      if (active) setRows(archived ? value as Row[] : (value as { sessions: Row[] }).sessions)
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, archived, refresh])
  const run = async (id: string, action: "rename" | "archive" | "restore" | "fork", name?: string) => {
    if (lock.current || rewindBusy) return
    lock.current = true; setBusy(true); setError(undefined)
    const owner = workspaceId
    try { await onManage(id, action, name); if (scope.current === owner) setRefresh((value) => value + 1) }
    catch (reason) { if (scope.current === owner) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  function confirmBatch(action: ManageSessionBatchCommand["action"]) {
    const sessionIds = (rows ?? []).filter(row => selected.has(row.id)).map(row => row.id)
    if (!sessionIds.length || rewindBusy) return
    setBatchConfirmation({ action, sessionIds, ...(action === "move" ? { ...(destination ? { projectId: destination } : {}), expectedOwners: Object.fromEntries(sessionIds.map(id => [id, currentOwners?.[id] ?? null])) } : {}) })
  }
  async function runBatch(retry?: ManageSessionBatchCommand) {
    const command = retry ?? batchConfirmation
    if (!onBatch || !command || lock.current || rewindBusy) return
    const owner = workspaceId
    lock.current = true; setBusy(true); setError(undefined)
    try {
      const result = await onBatch(command)
      if (scope.current !== owner) return
      setBatchResults(result); setBatchConfirmation(undefined)
      setSelected(new Set(result.results.filter(row => !row.ok).map(row => row.sessionId)))
      setRefresh(value => value + 1)
    } catch (error) { if (scope.current === owner) setError(error instanceof Error ? error.message : String(error)) }
    finally { lock.current = false; setBusy(false) }
  }
  const pageCount = Math.max(1, Math.ceil((rows?.length ?? 0) / 50))
  const currentPage = Math.min(page, pageCount - 1)
  const visibleRows = rows?.slice(currentPage * 50, (currentPage + 1) * 50)
  return <section className="session-manager" aria-label={t("管理會話")}>
    <h2 className="session-manager-heading">{t("管理會話")}</h2>
    <div className="provider-actions"><button disabled={blocked} aria-pressed={!archived} onClick={() => setArchived(false)}>{t("目前會話")}</button><button disabled={blocked} aria-pressed={archived} onClick={() => setArchived(true)}>{t("已封存會話")}</button></div>
    {onBatch ? <div className="provider-actions" aria-label={c("批次會話操作", "Batch conversation actions")}>
      <span>{c(`已選取 ${selected.size} 筆（每批最多 100 筆）`, `${selected.size} selected (up to 100 per batch)`)}</span>
      <button disabled={blocked || !selected.size || selected.size > 100} onClick={() => confirmBatch(archived ? "restore" : "archive")}>{archived ? c("還原所選會話", "Restore selected conversations") : c("封存所選會話", "Archive selected conversations")}</button>
      <button disabled={blocked || !selected.size || selected.size > 100} onClick={() => confirmBatch("delete")}>{c("永久刪除所選會話", "Permanently delete selected conversations")}</button>
      {projects && currentOwners && executionWorkspace ? <><label>{c("目的專案", "Destination project")}<select aria-label={c("目的專案", "Destination project")} value={destination} disabled={blocked} onChange={event => setDestination(event.target.value)}><option value="">{c("未分組", "Ungrouped")}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button disabled={blocked || !selected.size || selected.size > 100} onClick={() => confirmBatch("move")}>{c("移動所選會話", "Move selected conversations")}</button></> : null}
    </div> : null}
    {batchResults ? <section aria-label={c("批次操作結果", "Batch results")}><p>{c(`${batchResults.results.filter(row => row.ok).length} 筆完成，${batchResults.results.filter(row => !row.ok).length} 筆失敗`, `${batchResults.results.filter(row => row.ok).length} completed, ${batchResults.results.filter(row => !row.ok).length} failed`)}</p>{batchResults.results.map(row => <div key={row.sessionId} role={row.ok ? "status" : "alert"} className="batch-result"><span>{rows?.find(item => item.id === row.sessionId)?.title ?? row.sessionId} · {row.ok ? t("已完成") : row.sessionDeleted ? c("會話已刪除，本機草稿尚未清理。", "Conversation deleted. Local draft cleanup is incomplete.") : row.error}</span>{!row.ok && row.sessionDeleted ? <><details><summary>{c("詳細錯誤", "Error details")}</summary><pre className="tool-output">{row.error}</pre></details><button disabled={blocked} onClick={() => { void runBatch({ action: "delete", sessionIds: [row.sessionId] }) }}>{c("重試草稿清理", "Retry draft cleanup")}</button></> : null}</div>)}</section> : null}
    {error ? <p role="alert">{error}<button onClick={() => setRefresh(refresh + 1)}>{t("重試")}</button></p> : null}
    {rows === undefined && !error ? <p role="status">{t("正在讀取…")}</p> : null}
    {rows?.length === 0 ? <p>{t("尚無會話")}</p> : null}
    {pageCount > 1 ? <div className="provider-actions" aria-label={c("會話列表分頁", "Conversation list pages")}><button disabled={blocked || currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("上一頁")}</button><span>{currentPage + 1} / {pageCount}</span><button disabled={blocked || currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>{t("下一頁")}</button></div> : null}
    {visibleRows?.map((row) => <SettingsGroup key={row.id}>
      {onBatch ? <label><input type="checkbox" disabled={blocked} aria-label={`${c("選取", "Select")} ${row.title ?? row.id}`} checked={selected.has(row.id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next })} />{c("選取", "Select")}</label> : null}
      <SettingsRow label={row.title || t("未命名會話")} description={row.id} control={<div className="provider-actions">
        <button disabled={blocked} onClick={() => { setEditing(row.id); setTitle(row.title ?? "") }}>{t("重新命名")}</button>
        {archived ? <button disabled={blocked} onClick={() => { void run(row.id, "restore") }}>{t("還原會話")}</button> : <>
          <button disabled={blocked} onClick={() => { void run(row.id, "fork") }}>{t("建立分支")}</button>
          {onRewindComplete ? <button disabled={blocked} onClick={() => setRewinding(row.id)}>{t("回復會話")}</button> : null}
          <button disabled={blocked} onClick={() => { if (confirm === row.id) void run(row.id, "archive"); else setConfirm(row.id) }}>{t(confirm === row.id ? "確認封存" : "封存會話")}</button>
        </>}
      </div>} />
      {confirm === row.id ? <button disabled={blocked} onClick={() => setConfirm(undefined)}>{t("取消")}</button> : null}
      {editing === row.id ? <form className="provider-editor" onSubmit={(event) => { event.preventDefault(); void run(row.id, "rename", title) }}><label>{t("會話名稱")}<input required maxLength={256} disabled={blocked} value={title} onChange={(event) => setTitle(event.target.value)} /></label><button disabled={blocked || !title.trim()}>{t("儲存")}</button><button type="button" disabled={blocked} onClick={() => setEditing(undefined)}>{t("取消")}</button></form> : null}
    </SettingsGroup>)}
    {rewinding && onRewindComplete ? <RewindPanel key={rewinding} bridge={bridge} workspaceId={workspaceId} sessionId={rewinding} onBusyChange={setRewindBusy} onComplete={() => onRewindComplete(rewinding)} onClose={() => setRewinding(undefined)} /> : null}
    {batchConfirmation ? <SettingsDialog title={c("確認會話操作", "Confirm conversation action")} closeLabel={t("關閉對話框")} busy={blocked} initialFocusSelector=".batch-cancel" onClose={() => setBatchConfirmation(undefined)}>
      <h2>{batchConfirmation.action === "delete" ? c("永久刪除所選會話", "Permanently delete selected conversations") : batchConfirmation.action === "move" ? c("移動所選會話", "Move selected conversations") : batchConfirmation.action === "archive" ? c("封存所選會話", "Archive selected conversations") : c("還原所選會話", "Restore selected conversations")}</h2>
      <ul>{batchConfirmation.sessionIds.map(id => <li key={id} title={id}>{rows?.find(row => row.id === id)?.title ?? id}</li>)}</ul>
      {batchConfirmation.action === "delete" ? <p>{c("永久刪除保存的對話、會話文件及回復記錄，此操作無法還原。工作區來源檔案會保留。待處理輸入、互動、活躍工作或子會話會阻止刪除。", "Permanently delete saved conversations, session files and rewind records. This cannot be undone. Workspace source files are retained. Pending inputs, interactions, active work or child sessions prevent deletion.")}</p> : null}
      {batchConfirmation.action === "move" ? <><p>{c(`移至 ${projects?.find(project => project.id === batchConfirmation.projectId)?.name ?? "未分組"}。對話保留；專案允許的寫入資料夾會按目的專案重新計算。`, `Move to ${projects?.find(project => project.id === batchConfirmation.projectId)?.name ?? "Ungrouped"}. Conversations are retained; allowed write folders are recalculated for the destination project.`)}</p><p>{c(`執行起始資料夾及既有回復範圍仍為 ${executionWorkspace}。移動分組不會搬移來源檔案，也不提供讀取隔離。`, `The execution folder and existing rewind scope remain ${executionWorkspace}. Moving the group does not move source files or provide read isolation.`)}</p></> : null}
      <div className="provider-actions"><Button className="batch-cancel" variant="secondary" disabled={blocked} onClick={() => setBatchConfirmation(undefined)}>{t("取消")}</Button><Button variant={batchConfirmation.action === "delete" ? "danger" : "primary"} loading={busy} onClick={() => { void runBatch() }}>{batchConfirmation.action === "delete" ? c("確認永久刪除", "Confirm permanent deletion") : batchConfirmation.action === "move" ? c("確認移動", "Confirm move") : batchConfirmation.action === "archive" ? c("確認批次封存", "Confirm batch archive") : c("確認批次還原", "Confirm batch restore")}</Button></div>
      {error ? <p role="alert">{error}</p> : null}
    </SettingsDialog> : null}
  </section>
}
