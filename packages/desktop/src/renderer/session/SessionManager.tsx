import { useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { RewindPanel } from "./RewindPanel.tsx"
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
}
export function SessionManager({ bridge, workspaceId, onManage, onRewindComplete, initialArchived = false, onBatch, projects, currentOwners, executionWorkspace, initialSelected = [] }: SessionManagerProps) {
  const t = useText()
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
  const dialog = useRef<HTMLElement>(null)
  const initialSelectionKey = JSON.stringify(initialSelected)
  const scope = useRef(workspaceId)
  scope.current = workspaceId
  useEffect(() => { setSelected(new Set(initialSelected)); setBatchConfirmation(undefined); setBatchResults(undefined); setPage(0) }, [workspaceId, archived, initialSelectionKey])
  useEffect(() => {
    if (!batchConfirmation) return
    const previous = document.activeElement
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [batchConfirmation])
  useEffect(() => {
    let active = true
    setRows(undefined); setError(undefined); setEditing(undefined); setConfirm(undefined)
    void bridge.request({ kind: archived ? "desktop/session/archived" : "session/list", workspaceId }).then((value) => {
      if (active) setRows(archived ? value as Row[] : (value as { sessions: Row[] }).sessions)
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, archived, refresh])
  const run = async (id: string, action: "rename" | "archive" | "restore" | "fork", name?: string) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined)
    const owner = workspaceId
    try { await onManage(id, action, name); if (scope.current === owner) setRefresh((value) => value + 1) }
    catch (reason) { if (scope.current === owner) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  function confirmBatch(action: ManageSessionBatchCommand["action"]) {
    const sessionIds = (rows ?? []).filter(row => selected.has(row.id)).map(row => row.id)
    if (!sessionIds.length) return
    setBatchConfirmation({ action, sessionIds, ...(action === "move" ? { ...(destination ? { projectId: destination } : {}), expectedOwners: Object.fromEntries(sessionIds.map(id => [id, currentOwners?.[id] ?? null])) } : {}) })
  }
  async function runBatch(retry?: ManageSessionBatchCommand) {
    const command = retry ?? batchConfirmation
    if (!onBatch || !command || lock.current) return
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
  return <section aria-label={t("管理會話")}>
    <h2>{t("管理會話")}</h2>
    <div className="provider-actions"><button disabled={busy} aria-pressed={!archived} onClick={() => setArchived(false)}>{t("目前會話")}</button><button disabled={busy} aria-pressed={archived} onClick={() => setArchived(true)}>{t("已封存會話")}</button></div>
    {onBatch ? <div className="provider-actions" aria-label="批次會話操作">
      <span>已選取 {selected.size} 筆（每批最多 100 筆）</span>
      <button disabled={busy || !selected.size || selected.size > 100} onClick={() => confirmBatch(archived ? "restore" : "archive")}>{archived ? "還原所選會話" : "封存所選會話"}</button>
      <button disabled={busy || !selected.size || selected.size > 100} onClick={() => confirmBatch("delete")}>永久刪除所選會話</button>
      {projects && currentOwners && executionWorkspace ? <><label>目的專案<select aria-label="目的專案" value={destination} disabled={busy} onChange={event => setDestination(event.target.value)}><option value="">未分組</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button disabled={busy || !selected.size || selected.size > 100} onClick={() => confirmBatch("move")}>移動所選會話</button></> : null}
    </div> : null}
    {batchResults ? <div aria-label="批次操作結果"><p>{batchResults.results.filter(row => row.ok).length} 筆完成，{batchResults.results.filter(row => !row.ok).length} 筆失敗</p>{batchResults.results.map(row => <p key={row.sessionId} role={row.ok ? "status" : "alert"}>{rows?.find(item => item.id === row.sessionId)?.title ?? row.sessionId} · {row.ok ? "已完成" : row.error}{!row.ok && row.sessionDeleted ? <button disabled={busy} onClick={() => { void runBatch({ action: "delete", sessionIds: [row.sessionId] }) }}>重試草稿清理</button> : null}</p>)}</div> : null}
    {error ? <p role="alert">{error}<button onClick={() => setRefresh(refresh + 1)}>{t("重試")}</button></p> : null}
    {rows?.length === 0 ? <p>{t("尚無會話")}</p> : null}
    {pageCount > 1 ? <div className="provider-actions" aria-label="會話列表分頁"><button disabled={busy || currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("上一頁")}</button><span>{currentPage + 1} / {pageCount}</span><button disabled={busy || currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>{t("下一頁")}</button></div> : null}
    {visibleRows?.map((row) => <SettingsGroup key={row.id}>
      {onBatch ? <label><input type="checkbox" disabled={busy} aria-label={`選取 ${row.title ?? row.id}`} checked={selected.has(row.id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next })} />選取</label> : null}
      <SettingsRow label={row.title || t("未命名會話")} description={row.id} control={<div className="provider-actions">
        <button disabled={busy} onClick={() => { setEditing(row.id); setTitle(row.title ?? "") }}>{t("重新命名")}</button>
        {archived ? <button disabled={busy} onClick={() => { void run(row.id, "restore") }}>{t("還原會話")}</button> : <>
          <button disabled={busy} onClick={() => { void run(row.id, "fork") }}>{t("建立分支")}</button>
          {onRewindComplete ? <button disabled={busy} onClick={() => setRewinding(row.id)}>{t("回復會話")}</button> : null}
          <button disabled={busy} onClick={() => { if (confirm === row.id) void run(row.id, "archive"); else setConfirm(row.id) }}>{t(confirm === row.id ? "確認封存" : "封存會話")}</button>
        </>}
      </div>} />
      {confirm === row.id ? <button disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button> : null}
      {editing === row.id ? <form className="provider-editor" onSubmit={(event) => { event.preventDefault(); void run(row.id, "rename", title) }}><label>{t("會話名稱")}<input required maxLength={256} disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} /></label><button disabled={busy || !title.trim()}>{t("儲存")}</button><button type="button" disabled={busy} onClick={() => setEditing(undefined)}>{t("取消")}</button></form> : null}
    </SettingsGroup>)}
    {rewinding && onRewindComplete ? <RewindPanel key={rewinding} bridge={bridge} workspaceId={workspaceId} sessionId={rewinding} onComplete={() => onRewindComplete(rewinding)} onClose={() => setRewinding(undefined)} /> : null}
    {batchConfirmation ? <div className="session-rename-backdrop"><section ref={dialog} className="session-rename-dialog" role="dialog" aria-modal="true" aria-label="確認會話操作" style={{ maxHeight: "80vh", overflowY: "auto" }} onKeyDown={event => {
      if (event.key === "Escape" && !busy) setBatchConfirmation(undefined)
      if (event.key === "Tab") {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])
        if (!buttons.length) { event.preventDefault(); return }
        event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
      }
    }}>
      <h2>{batchConfirmation.action === "delete" ? "永久刪除所選會話" : batchConfirmation.action === "move" ? "移動所選會話" : batchConfirmation.action === "archive" ? "封存所選會話" : "還原所選會話"}</h2>
      <ul>{batchConfirmation.sessionIds.map(id => <li key={id}>{rows?.find(row => row.id === id)?.title ?? id} · {id}</li>)}</ul>
      {batchConfirmation.action === "delete" ? <p>永久刪除保存的對話、會話文件及回復記錄，此操作無法還原。工作區來源檔案會保留。待處理輸入、互動、活躍工作或子會話會阻止刪除。</p> : null}
      {batchConfirmation.action === "move" ? <><p>移至 {projects?.find(project => project.id === batchConfirmation.projectId)?.name ?? "未分組"}。對話保留；專案允許的寫入資料夾會按目的專案重新計算。</p><p>執行起始資料夾及既有回復範圍仍為 {executionWorkspace}。移動分組不會搬移來源檔案，也不提供讀取隔離。</p></> : null}
      <button disabled={busy} onClick={() => setBatchConfirmation(undefined)}>{t("取消")}</button><button disabled={busy} onClick={() => { void runBatch() }}>{batchConfirmation.action === "delete" ? "確認永久刪除" : batchConfirmation.action === "move" ? "確認移動" : batchConfirmation.action === "archive" ? "確認批次封存" : "確認批次還原"}</button>
      {error ? <p role="alert">{error}</p> : null}
    </section></div> : null}
  </section>
}
