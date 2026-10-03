import { useEffect, useRef, useState } from "react"
import { Bell, CheckCheck, RefreshCw, Trash2 } from "lucide-react"
import type { NotificationHistoryRequest, NotificationHistoryView } from "../../main/notification-history.ts"
import { useNotificationText } from "./notification-text.ts"
import "./notifications.css"

export function NotificationsPane({ request, onOpenTarget, subscribe }: {
  request(input: NotificationHistoryRequest): Promise<NotificationHistoryView>
  onOpenTarget(target: { workspaceId: string; sessionId: string }): Promise<void>
  subscribe?(listener: () => void): () => void
}) {
  const t = useNotificationText()
  const [view, setView] = useState<NotificationHistoryView>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const locked = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  async function load() {
    const own = ++generation.current
    try {
      const next = await request({ kind: "desktop/notifications/list" })
      if (mounted.current && own === generation.current) { setView(next); setError(undefined) }
    } catch (reason) { if (mounted.current && own === generation.current) setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  useEffect(() => {
    mounted.current = true
    void load()
    const unsubscribe = subscribe?.(() => { void load() })
    return () => { mounted.current = false; generation.current++; unsubscribe?.() }
  }, [request, subscribe])
  async function act(input: NotificationHistoryRequest) {
    if (locked.current) return
    locked.current = true; setBusy(true)
    const own = ++generation.current
    try {
      const next = await request(input)
      if (mounted.current && own === generation.current) { setView(next); setError(undefined); setConfirmClear(false) }
    } catch (reason) { if (mounted.current && own === generation.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { locked.current = false; if (mounted.current) setBusy(false) }
  }
  return <section className="notifications-pane" aria-label={t("通知記錄")}>
    <header className="notifications-heading"><div><h2><Bell size={18} />{t("通知記錄")}</h2><p className="muted">{view ? `${view.unread} ${t("未讀")}` : t("正在讀取…")}</p></div>
      <div className="provider-actions"><button type="button" className="icon-button" aria-label={t("重新整理通知")} disabled={busy} onClick={() => { void load() }}><RefreshCw size={16} /></button>
      <button type="button" className="secondary-button" disabled={busy || !view?.unread} onClick={() => { void act({ kind: "desktop/notifications/read" }) }}><CheckCheck size={15} />{t("全部標為已讀")}</button>
      <button type="button" className="icon-button" aria-label={t("清除通知記錄")} disabled={busy} onClick={() => setConfirmClear(true)}><Trash2 size={16} /></button></div>
    </header>
    {error ? <p role="alert" className="notice">{error}</p> : null}
    {confirmClear ? <div className="notifications-confirm" role="alertdialog" aria-label={t("清除所有通知記錄？")}><p>{t("清除所有通知記錄？")}</p><div className="provider-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmClear(false)}>{t("取消")}</button><button type="button" className="danger-button" disabled={busy} onClick={() => { void act({ kind: "desktop/notifications/clear", confirmed: true }) }}>{t("確認清除")}</button></div></div> : null}
    {view?.items.length === 0 ? <div className="notifications-empty"><Bell size={26} /><p>{t("尚無通知記錄")}</p><p className="muted">{t("需要確認或回答的通知會保留在這裡。")}</p></div> : null}
    <ul className="notifications-list">{view?.items.map(row => <li key={row.id} className={row.read ? "notification-read" : "notification-unread"}>
      <div className="notification-copy"><span className="notification-kind">{t(row.kind === "approval" ? "需要核准" : "等待回答")}</span><p>{row.summary}</p><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time></div>
      <div className="notification-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => { void onOpenTarget({ workspaceId: row.workspaceId, sessionId: row.sessionId }).catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }) }}>{t("開啟會話")}</button>
        {!row.read ? <button type="button" className="link-button" disabled={busy} onClick={() => { void act({ kind: "desktop/notifications/read", id: row.id }) }}>{t("標為已讀")}</button> : null}</div>
    </li>)}</ul>
  </section>
}
