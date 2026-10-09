import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { Archive, Copy, FolderOpen, GitBranch, Mail, MailOpen, Pencil, Pin, PinOff } from "lucide-react"
import { useText } from "../design/i18n.ts"
import { listenForegroundEscape } from "../design/foreground-escape.ts"
import "./session-actions.css"

export type SessionAction = "rename" | "archive" | "restore" | "fork" | "pin" | "unpin" | "read" | "unread"
export interface SessionNavigation { pinned: boolean; unread: boolean }
export interface SessionActionsProps {
  session: { id: string; title?: string; running?: boolean; queued?: number; turnCount?: number }
  navigation?: SessionNavigation
  anchor: { x: number; y: number; element: HTMLElement }
  onManage?(sessionId: string, action: SessionAction, title?: string): Promise<void>
  onCopyId?(sessionId: string): Promise<void>
  onOpenFolder?(): Promise<void>
  onManageSession?(sessionId: string): void
  onClose(): void
}

/** Native sidebar affordances, using this app's existing management services. */
export function SessionActions({ session, navigation, anchor, onManage, onCopyId, onOpenFolder, onManageSession, onClose }: SessionActionsProps) {
  const t = useText()
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(session.title ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y })
  const root = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const lock = useRef(false)
  const composing = useRef(false)
  const close = () => { onClose(); if (anchor.element.isConnected) anchor.element.focus() }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => listenForegroundEscape(root.current, close, () => lock.current), [renaming])
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    if (!renaming) {
      const rect = element.getBoundingClientRect()
      setPosition({ left: Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8)) })
    }
    element.querySelector<HTMLElement>(renaming ? "input" : "button:not(:disabled)")?.focus()
  }, [renaming, anchor.x, anchor.y])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!lock.current && event.target instanceof Node && !root.current?.contains(event.target)) close()
    }
    const scroll = (event: Event) => {
      if (!renaming && !lock.current && event.target instanceof Node && !root.current?.contains(event.target)) close()
    }
    document.addEventListener("pointerdown", outside)
    window.addEventListener("scroll", scroll, true)
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("scroll", scroll, true) }
  })

  async function run(action: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined)
    try { await action(); if (alive.current) close() }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return
    if (event.key === "Escape") return
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>(renaming ? "input:not(:disabled),button:not(:disabled)" : '[role="menuitem"]:not(:disabled)') ?? [])
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    if (renaming && event.key === "Tab") {
      event.preventDefault(); items[(current + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus()
    } else if (!renaming && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault()
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length
      items[next]?.focus()
    } else if (!renaming && event.key === "Tab") close()
  }
  const structuralBusy = busy || session.running === true || (session.queued ?? 0) > 0
  const manage = (action: SessionAction, name?: string) => { if (onManage) void run(() => onManage(session.id, action, name)) }

  return createPortal(renaming ? <div className="session-rename-backdrop">
    <div ref={root} className="session-rename-dialog" role="dialog" aria-modal="true" aria-label={t("重新命名")} aria-busy={busy} onKeyDown={keyboard}>
      <h2>{t("重新命名")}</h2>
      <form onSubmit={(event) => { event.preventDefault(); if (title.trim() && !composing.current) manage("rename", title.trim()) }}>
        <label>{t("會話名稱")}<input value={title} maxLength={256} disabled={busy} onChange={(event) => setTitle(event.target.value)} onFocus={(event) => event.currentTarget.select()} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing)) event.preventDefault() }} /></label>
        {error ? <p role="alert" className="error-text">{error}</p> : null}
        <div className="session-rename-actions"><button type="button" disabled={busy} onClick={close}>{t("取消")}</button><button type="submit" disabled={busy || !title.trim()}>{t(busy ? "正在處理…" : "儲存")}</button></div>
      </form>
    </div>
  </div> : <div ref={root} className="session-action-menu" role="menu" aria-label={t("會話操作")} aria-busy={busy} style={position} onKeyDown={keyboard}>
    {onManage ? <>
      <button type="button" role="menuitem" disabled={busy} onClick={() => manage(navigation?.pinned ? "unpin" : "pin")}>{navigation?.pinned ? <PinOff size={15} /> : <Pin size={15} />}{t(navigation?.pinned ? "取消釘選" : "釘選會話")}</button>
      <button type="button" role="menuitem" disabled={structuralBusy} onClick={() => { setError(undefined); setRenaming(true) }}><Pencil size={15} />{t("重新命名")}</button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => manage(navigation?.unread ? "read" : "unread")}>{navigation?.unread ? <MailOpen size={15} /> : <Mail size={15} />}{t(navigation?.unread ? "標記為已讀" : "標記為未讀")}</button>
      <button type="button" role="menuitem" disabled={structuralBusy || session.turnCount === 0} title={session.turnCount === 0 ? t("完成一輪後才能建立分支") : undefined} onClick={() => manage("fork")}><GitBranch size={15} />{t("建立分支")}</button>
      <button type="button" role="menuitem" disabled={structuralBusy} onClick={() => manage("archive")}><Archive size={15} />{t("封存會話")}</button>
    </> : null}
    {onManageSession ? <button type="button" role="menuitem" disabled={busy} onClick={() => { onManageSession(session.id); close() }}><Archive size={15} />{t("管理此會話")}</button> : null}
    {onCopyId || onOpenFolder ? <div className="session-menu-separator" role="separator" /> : null}
    {onCopyId ? <button type="button" role="menuitem" disabled={busy} onClick={() => { void run(() => onCopyId(session.id)) }}><Copy size={15} />{t("複製會話 ID")}</button> : null}
    {onOpenFolder ? <button type="button" role="menuitem" disabled={busy} onClick={() => { void run(onOpenFolder) }}><FolderOpen size={15} />{t("開啟工作區資料夾")}</button> : null}
    {busy ? <p role="status">{t("正在處理…")}</p> : null}
    {error ? <p role="alert" className="error-text">{error}</p> : null}
  </div>, document.body)
}
