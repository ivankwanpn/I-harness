import { useEffect, useId, useRef, useState } from "react"
import { Archive, ArchiveRestore, Check, ChevronDown, ChevronLeft, ChevronRight, Folder, FolderInput, GitBranch, MessageSquare, MoreHorizontal, Pencil, RotateCcw, Trash2 } from "lucide-react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale, useText } from "../design/i18n.ts"
import { relativeActivity } from "../shell/relative-activity.ts"
import { RewindPanel } from "./RewindPanel.tsx"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { managementError } from "./management-error.ts"
import { SessionManagerMenu } from "./SessionManagerMenu.tsx"
import "./session-manager.css"
export type ManageSession = (sessionId: string, action: "rename" | "archive" | "restore" | "fork" | "pin" | "unpin" | "read" | "unread", title?: string) => Promise<void>
interface Row { id: string; title?: string; projectId?: string; updatedAt?: number; turnCount?: number }
interface Menu { kind: "session" | "destination"; sessionId?: string; element: HTMLButtonElement; workspaceId: string; archived: boolean }
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
  const locale = useLocale(state => state.locale)
  const english = locale === "en"
  const c = (zh: string, en: string) => english ? en : zh
  const menuId = useId()
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
  const [menu, setMenu] = useState<Menu>()
  const rowTriggers = useRef(new Map<string, HTMLButtonElement>())
  const rewindPanel = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const blocked = busy || rewindBusy
  const batchBlocked = blocked || !selected.size || selected.size > 100
  const busyListener = useRef(onBusyChange)
  busyListener.current = onBusyChange
  useEffect(() => { busyListener.current?.(busy || rewindBusy) }, [busy, rewindBusy])
  useEffect(() => () => { busyListener.current?.(false) }, [])
  const initialSelectionKey = JSON.stringify(initialSelected)
  const scope = useRef({ workspaceId, archived })
  if (scope.current.workspaceId !== workspaceId || scope.current.archived !== archived) scope.current = { workspaceId, archived }
  useEffect(() => { setSelected(new Set(initialSelected)); setBatchConfirmation(undefined); setBatchResults(undefined); setPage(0); setMenu(undefined); setRewinding(undefined) }, [workspaceId, archived, initialSelectionKey])
  useEffect(() => { rewindPanel.current?.querySelector<HTMLSelectElement>("select")?.focus() }, [rewinding])
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
    const owner = scope.current
    try { await onManage(id, action, name); if (scope.current === owner) setRefresh((value) => value + 1) }
    catch (reason) { if (scope.current === owner) setError(managementError(reason, english)) }
    finally { lock.current = false; setBusy(false) }
  }
  function confirmBatch(action: ManageSessionBatchCommand["action"]) {
    const sessionIds = (rows ?? []).filter(row => selected.has(row.id)).map(row => row.id)
    if (!sessionIds.length || sessionIds.length > 100 || blocked) return
    setBatchConfirmation({ action, sessionIds, ...(action === "move" ? { ...(destination ? { projectId: destination } : {}), expectedOwners: Object.fromEntries(sessionIds.map(id => [id, currentOwners?.[id] ?? null])) } : {}) })
  }
  async function runBatch(retry?: ManageSessionBatchCommand) {
    const command = retry ?? batchConfirmation
    if (!onBatch || !command || lock.current || rewindBusy) return
    const owner = scope.current
    lock.current = true; setBusy(true); setError(undefined)
    try {
      const result = await onBatch(command)
      if (scope.current !== owner) return
      setBatchResults(result); setBatchConfirmation(undefined)
      setSelected(new Set(result.results.filter(row => !row.ok).map(row => row.sessionId)))
      setRefresh(value => value + 1)
    } catch (error) { if (scope.current === owner) setError(managementError(error, english)) }
    finally { lock.current = false; setBusy(false) }
  }
  const pageCount = Math.max(1, Math.ceil((rows?.length ?? 0) / 50))
  const currentPage = Math.min(page, pageCount - 1)
  const visibleRows = rows?.slice(currentPage * 50, (currentPage + 1) * 50)
  const activeMenu = menu?.workspaceId === workspaceId && menu.archived === archived && !blocked ? menu : undefined
  const menuRow = activeMenu?.kind === "session" ? rows?.find(row => row.id === activeMenu.sessionId) : undefined
  const closeMenu = (restoreFocus = true) => { setMenu(undefined); if (restoreFocus && menu?.element.isConnected) menu.element.focus({ preventScroll: true }) }
  const showMenu = (kind: Menu["kind"], element: HTMLButtonElement, sessionId?: string) => {
    if (blocked) return
    if (activeMenu?.element === element) closeMenu()
    else setMenu({ kind, sessionId, element, workspaceId, archived })
  }
  const projectName = (row: Row) => {
    const owner = row.projectId ?? currentOwners?.[row.id]
    if (owner) return projects?.find(project => project.id === owner)?.name ?? t("專案已移除")
    return currentOwners && Object.hasOwn(currentOwners, row.id) ? c("未分組", "Ungrouped") : undefined
  }
  const action = (kind: "rename" | "archive" | "restore" | "fork" | "rewind") => {
    if (!menuRow || blocked) return
    closeMenu(); setError(undefined)
    if (kind === "rename") { composing.current = false; setEditing(menuRow.id); setTitle(menuRow.title ?? "") }
    else if (kind === "archive") setConfirm(menuRow.id)
    else if (kind === "rewind") setRewinding(menuRow.id)
    else void run(menuRow.id, kind)
  }
  const failed = batchResults?.results.filter(row => !row.ok).length ?? 0
  return <section className="session-manager ih-control-scope" aria-label={t("管理會話")}>
    <h2 className="session-manager-heading">{t("管理會話")}</h2>
    <div className="session-manager-toolbar">
      <div className="session-manager-navigation">
        <div className="session-manager-tabs" role="group" aria-label={c("會話列表", "Conversation lists")}>
          <Button variant="ghost" size="small" disabled={blocked} aria-pressed={!archived} icon={<MessageSquare size={14} />} onClick={() => setArchived(false)}>{t("目前會話")}</Button>
          <Button variant="ghost" size="small" disabled={blocked} aria-pressed={archived} icon={<Archive size={14} />} onClick={() => setArchived(true)}>{t("已封存會話")}</Button>
        </div>
        {rows ? <span className="session-manager-total">{c(`${rows.length} 筆會話`, `${rows.length} conversations`)}</span> : null}
      </div>
      {onBatch ? <div className="session-manager-batch" role="group" aria-label={c("批次會話操作", "Batch conversation actions")}>
        <div className="session-manager-batch-actions">
          <div className="session-manager-selection" aria-live="polite"><strong>{c(`已選取 ${selected.size} 筆`, `${selected.size} selected`)}</strong><span>{c("每批最多 100 筆", "Up to 100 per batch")}</span></div>
          <Button variant="ghost" size="small" disabled={blocked || !selected.size} onClick={() => setSelected(new Set())}>{c("取消選取", "Clear selection")}</Button>
          <Button size="small" disabled={batchBlocked} aria-label={archived ? c("還原所選會話", "Restore selected conversations") : c("封存所選會話", "Archive selected conversations")} icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} onClick={() => confirmBatch(archived ? "restore" : "archive")}>{archived ? c("還原", "Restore") : c("封存", "Archive")}</Button>
          <Button variant="danger" size="small" disabled={batchBlocked} aria-label={c("永久刪除所選會話", "Permanently delete selected conversations")} icon={<Trash2 size={14} />} onClick={() => confirmBatch("delete")}>{c("永久刪除", "Delete permanently")}</Button>
        </div>
        {projects && currentOwners && executionWorkspace ? <div className="session-manager-move">
          <span>{c("目的專案", "Destination project")}</span>
          <Button size="small" className="session-manager-destination" aria-label={c("目的專案", "Destination project")} aria-haspopup="menu" aria-expanded={activeMenu?.kind === "destination"} aria-controls={activeMenu?.kind === "destination" ? menuId : undefined} disabled={blocked} icon={<Folder size={14} />} onClick={event => showMenu("destination", event.currentTarget)}><span>{destination ? projects.find(project => project.id === destination)?.name ?? t("專案已移除") : c("未分組", "Ungrouped")}</span><ChevronDown size={13} aria-hidden /></Button>
          <Button size="small" disabled={batchBlocked} aria-label={c("移動所選會話", "Move selected conversations")} icon={<FolderInput size={14} />} onClick={() => confirmBatch("move")}>{c("移動", "Move")}</Button>
        </div> : null}
      </div> : null}
    </div>
    <div className="session-manager-scroll">
      {batchResults ? <section className="session-manager-results" aria-label={c("批次操作結果", "Batch results")}><details open={failed > 0}>
        <summary>{c(`${batchResults.results.length - failed} 筆完成，${failed} 筆失敗`, `${batchResults.results.length - failed} completed, ${failed} failed`)}</summary>
        {batchResults.results.map(row => <div key={row.sessionId} role={row.ok ? "status" : "alert"} className="session-manager-result"><span>{rows?.find(item => item.id === row.sessionId)?.title ?? row.sessionId} · {row.ok ? t("已完成") : row.sessionDeleted ? c("會話已刪除，本機草稿尚未清理。", "Conversation deleted. Local draft cleanup is incomplete.") : managementError(row.error, english)}</span>{!row.ok && row.sessionDeleted ? <><details><summary>{c("詳細錯誤", "Error details")}</summary><pre className="tool-output">{row.error}</pre></details><Button size="small" disabled={blocked} onClick={() => { void runBatch({ action: "delete", sessionIds: [row.sessionId] }) }}>{c("重試草稿清理", "Retry draft cleanup")}</Button></> : null}</div>)}
      </details></section> : null}
      {error && !editing && !confirm && !batchConfirmation ? <div className="session-manager-error" role="alert"><span>{error}</span><Button size="small" disabled={blocked} onClick={() => setRefresh(refresh + 1)}>{t("重試")}</Button></div> : null}
      {rows === undefined && !error ? <p className="session-manager-state" role="status">{t("正在讀取…")}</p> : null}
      {rows?.length === 0 ? <p className="session-manager-state">{t("尚無會話")}</p> : null}
      {visibleRows?.length ? <ul className="session-manager-list" aria-label={c("會話列表", "Conversation list")}>{visibleRows.map(row => {
        const name = row.title || t("未命名會話")
        const project = projectName(row)
        const date = row.updatedAt === undefined ? undefined : new Date(row.updatedAt)
        const validDate = date && Number.isFinite(date.getTime()) ? date : undefined
        return <li key={row.id} className="session-manager-item" data-selected={selected.has(row.id) || undefined}>
          <div className="session-manager-row">
            {onBatch ? <input className="session-manager-checkbox" type="checkbox" disabled={blocked || selected.size >= 100 && !selected.has(row.id)} aria-label={`${c("選取", "Select")} ${row.title ?? row.id}`} checked={selected.has(row.id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked && next.size < 100) next.add(row.id); else if (!event.target.checked) next.delete(row.id); return next })} /> : null}
            <div className="session-manager-info">
              <h3 title={name}>{name}</h3>
              {project || validDate || row.turnCount !== undefined ? <div className="session-manager-meta">
                {project ? <span className="session-manager-project" title={project}><Folder size={12} aria-hidden /><span>{project}</span></span> : null}
                {validDate ? <time dateTime={validDate.toISOString()} title={validDate.toLocaleString(locale)}>{relativeActivity(validDate.getTime(), locale)}</time> : null}
                {row.turnCount !== undefined ? <span>{row.turnCount} {t("回合")}</span> : null}
              </div> : null}
            </div>
            <Button variant="ghost" size="small" className="session-manager-more" disabled={blocked} aria-label={t("更多會話操作 {title}", { title: name })} aria-haspopup="menu" aria-expanded={menuRow?.id === row.id} aria-controls={menuRow?.id === row.id ? menuId : undefined} icon={<MoreHorizontal size={17} />} onClick={event => { rowTriggers.current.set(row.id, event.currentTarget); showMenu("session", event.currentTarget, row.id) }} />
          </div>
          {rewinding === row.id && onRewindComplete ? <div ref={rewindPanel} className="session-manager-rewind"><RewindPanel key={row.id} bridge={bridge} workspaceId={workspaceId} sessionId={row.id} onBusyChange={setRewindBusy} onComplete={() => onRewindComplete(row.id)} onClose={() => { setRewinding(undefined); rowTriggers.current.get(row.id)?.focus({ preventScroll: true }) }} /></div> : null}
        </li>
      })}</ul> : null}
    </div>
    {pageCount > 1 ? <div className="session-manager-pagination" role="group" aria-label={c("會話列表分頁", "Conversation list pages")}><span>{c(`${currentPage * 50 + 1}–${Math.min((currentPage + 1) * 50, rows?.length ?? 0)} / ${rows?.length ?? 0} 筆`, `${currentPage * 50 + 1}–${Math.min((currentPage + 1) * 50, rows?.length ?? 0)} of ${rows?.length ?? 0}`)}</span><div><Button variant="ghost" size="small" disabled={blocked || currentPage === 0} icon={<ChevronLeft size={14} />} onClick={() => setPage(currentPage - 1)}>{t("上一頁")}</Button><span>{currentPage + 1} / {pageCount}</span><Button variant="ghost" size="small" disabled={blocked || currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>{t("下一頁")}<ChevronRight size={14} aria-hidden /></Button></div></div> : null}
    {activeMenu && (activeMenu.kind === "destination" || menuRow) ? <SessionManagerMenu id={menuId} label={activeMenu.kind === "destination" ? c("目的專案", "Destination project") : `${t("會話操作")} ${menuRow!.title || t("未命名會話")}`} anchor={activeMenu.element} initialFocusSelector={activeMenu.kind === "destination" ? '[aria-checked="true"]' : undefined} onClose={closeMenu}>
      {activeMenu.kind === "destination" ? [{ id: "", name: c("未分組", "Ungrouped") }, ...(projects ?? [])].map(project => <button className="session-manager-menu-item" key={project.id} type="button" role="menuitemradio" aria-checked={destination === project.id} onClick={() => { setDestination(project.id); closeMenu() }}><Folder size={15} aria-hidden /><span>{project.name}</span>{destination === project.id ? <Check size={14} aria-hidden /> : null}</button>) : <>
        <button className="session-manager-menu-item" type="button" role="menuitem" onClick={() => action("rename")}><Pencil size={15} aria-hidden />{t("重新命名")}</button>
        {archived ? <button className="session-manager-menu-item" type="button" role="menuitem" onClick={() => action("restore")}><ArchiveRestore size={15} aria-hidden />{t("還原會話")}</button> : <>
          <button className="session-manager-menu-item" type="button" role="menuitem" onClick={() => action("fork")}><GitBranch size={15} aria-hidden />{t("建立分支")}</button>
          {onRewindComplete ? <button className="session-manager-menu-item" type="button" role="menuitem" onClick={() => action("rewind")}><RotateCcw size={15} aria-hidden />{t("回復會話")}</button> : null}
          <button className="session-manager-menu-item" type="button" role="menuitem" onClick={() => action("archive")}><Archive size={15} aria-hidden />{t("封存會話")}</button>
        </>}
        <div className="session-manager-menu-id"><span>{c("會話 ID", "Conversation ID")}</span><code>{menuRow!.id}</code></div>
      </>}
    </SessionManagerMenu> : null}
    {editing ? <SettingsDialog title={t("重新命名")} closeLabel={t("關閉對話框")} busy={blocked} initialFocusSelector="input" onClose={() => setEditing(undefined)}>
      <form className="session-manager-rename" onSubmit={event => { event.preventDefault(); if (title.trim() && !composing.current) void run(editing, "rename", title) }}>
        <label>{t("會話名稱")}<input className="ih-control" required maxLength={256} disabled={blocked} value={title} onChange={event => setTitle(event.target.value)} onFocus={event => event.currentTarget.select()} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => { if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing)) event.preventDefault() }} /></label>
        {error ? <p role="alert">{error}</p> : null}
        <div className="session-manager-confirm-actions"><Button variant="secondary" disabled={blocked} onClick={() => setEditing(undefined)}>{t("取消")}</Button><Button type="submit" variant="primary" disabled={blocked || !title.trim()} loading={busy}>{t("儲存")}</Button></div>
      </form>
    </SettingsDialog> : null}
    {confirm ? <SettingsDialog title={t("封存會話")} closeLabel={t("關閉對話框")} busy={blocked} initialFocusSelector=".session-manager-cancel" onClose={() => setConfirm(undefined)}>
      <p>{c("封存後可從已封存會話列表還原。", "You can restore this conversation from the archived list.")}</p><p className="session-manager-confirm-title">{rows?.find(row => row.id === confirm)?.title || t("未命名會話")}</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="session-manager-confirm-actions"><Button className="session-manager-cancel" variant="secondary" disabled={blocked} onClick={() => setConfirm(undefined)}>{t("取消")}</Button><Button variant="primary" loading={busy} onClick={() => { void run(confirm, "archive") }}>{t("確認封存")}</Button></div>
    </SettingsDialog> : null}
    {batchConfirmation ? <SettingsDialog title={c("確認會話操作", "Confirm conversation action")} closeLabel={t("關閉對話框")} busy={blocked} initialFocusSelector=".batch-cancel" onClose={() => setBatchConfirmation(undefined)}>
      <h2>{batchConfirmation.action === "delete" ? c("永久刪除所選會話", "Permanently delete selected conversations") : batchConfirmation.action === "move" ? c("移動所選會話", "Move selected conversations") : batchConfirmation.action === "archive" ? c("封存所選會話", "Archive selected conversations") : c("還原所選會話", "Restore selected conversations")}</h2>
      <ul className="session-manager-confirm-list">{batchConfirmation.sessionIds.map(id => <li key={id} title={id}>{rows?.find(row => row.id === id)?.title ?? id}</li>)}</ul>
      {batchConfirmation.action === "delete" ? <p>{c("永久刪除保存的對話、會話文件及回復記錄，此操作無法還原。工作區來源檔案會保留。待處理輸入、互動、活躍工作或子會話會阻止刪除。", "Permanently delete saved conversations, session files and rewind records. This cannot be undone. Workspace source files are retained. Pending inputs, interactions, active work or child sessions prevent deletion.")}</p> : null}
      {batchConfirmation.action === "move" ? <><p>{c(`移至 ${projects?.find(project => project.id === batchConfirmation.projectId)?.name ?? "未分組"}。對話保留；專案允許的寫入資料夾會按目的專案重新計算。`, `Move to ${projects?.find(project => project.id === batchConfirmation.projectId)?.name ?? "Ungrouped"}. Conversations are retained; allowed write folders are recalculated for the destination project.`)}</p><p>{c(`執行起始資料夾及既有回復範圍仍為 ${executionWorkspace}。移動分組不會搬移來源檔案，也不提供讀取隔離。`, `The execution folder and existing rewind scope remain ${executionWorkspace}. Moving the group does not move source files or provide read isolation.`)}</p></> : null}
      <div className="session-manager-confirm-actions"><Button className="batch-cancel" variant="secondary" disabled={blocked} onClick={() => setBatchConfirmation(undefined)}>{t("取消")}</Button><Button variant={batchConfirmation.action === "delete" ? "danger" : "primary"} loading={busy} onClick={() => { void runBatch() }}>{batchConfirmation.action === "delete" ? c("確認永久刪除", "Confirm permanent deletion") : batchConfirmation.action === "move" ? c("確認移動", "Confirm move") : batchConfirmation.action === "archive" ? c("確認批次封存", "Confirm batch archive") : c("確認批次還原", "Confirm batch restore")}</Button></div>
      {error ? <p role="alert">{error}</p> : null}
    </SettingsDialog> : null}
  </section>
}
