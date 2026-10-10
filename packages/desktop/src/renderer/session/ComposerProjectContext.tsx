import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { Check, ChevronDown, Folder, Search } from "lucide-react"
import type { ProjectEntry } from "../../main/projects.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import { useText } from "../design/i18n.ts"
import { listenForegroundEscape } from "../design/foreground-escape.ts"
import "./ComposerProjectContext.css"

export type ComposerProjectState = { status: "loading" | "unavailable" } | { status: "ready"; projectId?: string; projectName?: string }

export function ComposerProjectContext({ context, projects, workspaces, editable, disabled = false, onSelect, onUnassign, onManage }: {
  context: ComposerProjectState
  projects?: ProjectEntry[]
  workspaces: WorkspaceEntry[]
  editable: boolean
  disabled?: boolean
  onSelect?(id: string): void
  onUnassign?(): void
  onManage?(): void
}) {
  const t = useText(), id = useId()
  const [open, setOpen] = useState(false), [query, setQuery] = useState("")
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>({ left: 12, bottom: 100, maxHeight: 320 })
  const current = context.status === "ready" ? context : undefined
  const label = context.status === "loading" ? t("正在確認專案…") : context.status === "unavailable" ? t("專案歸屬無法確認")
    : current?.projectId ? current.projectName ?? t("專案已移除") : t(editable && !onUnassign ? "選擇專案" : "不在專案中")
  const selectable = editable && !!onSelect
  const close = (restoreFocus = true) => { setOpen(false); if (restoreFocus) trigger.current?.focus() }
  useEffect(() => { setOpen(false); setQuery("") }, [editable, disabled, context.status, current?.projectId])
  useLayoutEffect(() => {
    if (!open || disabled || !selectable) return
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const above = rect.top - 18, below = window.innerHeight - rect.bottom - 18
      const up = above >= 180 || above >= below
      setPlacement({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 332)), ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }), maxHeight: Math.max(0, Math.min(360, up ? above : below)) })
    }
    position(); panel.current?.querySelector<HTMLInputElement>("input")?.focus()
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(false) }
    const escape = listenForegroundEscape(panel.current, () => close())
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true); document.addEventListener("pointerdown", outside)
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); document.removeEventListener("pointerdown", outside); escape() }
  }, [open, disabled, selectable])
  const folder = (project: ProjectEntry) => {
    const primary = project.primaryWorkspaceId ?? project.workspaceIds[0]
    return primary && project.workspaceIds.includes(primary) ? workspaces.find(row => row.id === primary) : undefined
  }
  const visible = (projects ?? []).filter(project => `${project.name} ${folder(project)?.path ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const choose = (action: () => void) => { if (disabled) return; close(); action() }
  const keyboard = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    const options = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])
    if (!options.length) return
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); options[event.key === "ArrowDown" ? (index + 1) % options.length : (index <= 0 ? options.length : index) - 1]?.focus()
    }
  }
  return <div className="composer-project-context" role="group" aria-label={t("會話專案")}>
    {selectable ? <button ref={trigger} type="button" className="composer-project-trigger" aria-label={t("選擇會話專案")} aria-haspopup="dialog" aria-expanded={open && !disabled} aria-controls={open ? id : undefined}
      disabled={disabled || projects === undefined} title={label} onClick={() => { setQuery(""); setOpen(value => !value) }}>
      <Folder size={14} aria-hidden /><span>{label}</span><ChevronDown size={12} aria-hidden />
    </button> : <span className="composer-project-label" title={current?.projectId && !current.projectName ? current.projectId : label} aria-live="polite"><Folder size={14} aria-hidden /><span>{label}</span></span>}
    {open && !disabled && selectable ? createPortal(<div ref={panel} id={id} role="dialog" aria-label={t("選擇專案")} className="composer-project-picker" style={placement} onKeyDown={keyboard}>
      <label className="composer-project-search"><Search size={14} aria-hidden /><input type="search" aria-label={t("搜尋專案")} placeholder={t("搜尋專案")} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="composer-project-options">{visible.map(project => {
        const primary = folder(project)
        return <button type="button" key={project.id} className="composer-project-option" aria-pressed={current?.projectId === project.id} disabled={!primary} title={primary?.path ?? t("尚未加入資料夾")} onClick={() => choose(() => onSelect?.(project.id))}>
          <Folder size={14} aria-hidden /><span><strong>{project.name}</strong><small>{primary?.path ?? t("尚未加入資料夾")}</small></span>{current?.projectId === project.id ? <Check size={14} aria-hidden /> : null}
        </button>
      })}{!visible.length ? <p className="composer-project-empty">{t("沒有符合的專案")}</p> : null}</div>
      <div className="composer-project-picker-actions">{onManage ? <button type="button" onClick={() => choose(onManage)}>{t("管理專案")}</button> : null}
        {onUnassign ? <button type="button" aria-pressed={!current?.projectId} onClick={() => choose(onUnassign)}>{t("不在專案中工作")}</button> : null}</div>
    </div>, document.body) : null}
  </div>
}
