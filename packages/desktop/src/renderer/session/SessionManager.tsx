import { useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { RewindPanel } from "./RewindPanel.tsx"
export type ManageSession = (sessionId: string, action: "rename" | "archive" | "restore" | "fork" | "pin" | "unpin" | "read" | "unread", title?: string) => Promise<void>
interface Row { id: string; title?: string }
export function SessionManager({ bridge, workspaceId, onManage, onRewindComplete, initialArchived = false }: { bridge: DesktopBridge; workspaceId: string; onManage: ManageSession; onRewindComplete?: (sessionId: string) => void; initialArchived?: boolean }) {
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
    try { await onManage(id, action, name); setRefresh((value) => value + 1) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <section aria-label={t("管理會話")}>
    <h2>{t("管理會話")}</h2>
    <div className="provider-actions"><button disabled={busy} aria-pressed={!archived} onClick={() => setArchived(false)}>{t("目前會話")}</button><button disabled={busy} aria-pressed={archived} onClick={() => setArchived(true)}>{t("已封存會話")}</button></div>
    {error ? <p role="alert">{error}<button onClick={() => setRefresh(refresh + 1)}>{t("重試")}</button></p> : null}
    {rows?.length === 0 ? <p>{t("尚無會話")}</p> : null}
    {rows?.map((row) => <SettingsGroup key={row.id}>
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
  </section>
}
