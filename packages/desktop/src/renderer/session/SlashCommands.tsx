import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { BookOpen, Command, LoaderCircle, Puzzle, Search, Terminal } from "lucide-react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { ResourceSuggestion, ResourceSuggestionPage } from "@i-harness/desktop-gateway/src/resources.ts"
import { useText } from "../design/i18n.ts"
import { listenForegroundEscape } from "../design/foreground-escape.ts"
import type { PickerKeyboard } from "./ContextPicker.tsx"
import "./SlashCommands.css"

type Suggestion = Omit<ResourceSuggestion, "source"> & { source: ResourceSuggestion["source"] | "builtin" }
const identity = (row: Suggestion) => JSON.stringify([row.kind, row.source, row.pluginId, row.name])
interface Snapshot { bridge: DesktopBridge; workspaceId: string; query: string; page: ResourceSuggestionPage; loading: boolean; error?: string }
interface Placement { left: number; width: number; maxHeight: number; top?: number; bottom?: number }
function anchorIsVisible(anchor: HTMLElement | null | undefined): boolean {
  for (let element = anchor; element; element = element.parentElement) {
    if (element.hidden || element.inert || element.getAttribute("aria-hidden") === "true") return false
    const style = window.getComputedStyle(element)
    if (style.display === "none" || style.visibility === "hidden") return false
  }
  return true
}

/** Grouped composer overlay: source/interaction references in SLASH_SOURCES.md. */
export const SlashCommands = forwardRef<PickerKeyboard, {
  bridge: DesktopBridge; workspaceId: string; text: string; showCompact?: boolean;
  onSelect(name: string, kind?: "skill"): void; workflows?: boolean; settings?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
}>(function SlashCommands({ bridge, workspaceId, text, showCompact = false, onSelect, workflows = false, settings = false, anchorRef }, ref) {
  const t = useText(), id = useId()
  const prefix = /^\/([^\s]*)$/u.exec(text)?.[1]
  const query = (prefix ?? "").replace(/^\$/, "")
  const signature = JSON.stringify([workspaceId, text])
  const [dismissed, setDismissed] = useState<string>()
  const [anchorVisible, setAnchorVisible] = useState(true)
  const active = prefix !== undefined && signature !== dismissed && anchorVisible
  const [selected, setSelected] = useState<string>()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const panel = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement>({ left: 12, bottom: 12, width: 420, maxHeight: 380 })
  const current = snapshot?.bridge === bridge && snapshot.workspaceId === workspaceId && snapshot.query === query ? snapshot : undefined

  useLayoutEffect(() => {
    const anchor = anchorRef?.current
    const update = () => setAnchorVisible(anchorIsVisible(anchor))
    update()
    if (!anchor) return
    const observer = new MutationObserver(update)
    for (let element: HTMLElement | null = anchor; element; element = element.parentElement) {
      observer.observe(element, { attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "class", "style"] })
    }
    return () => observer.disconnect()
  }, [anchorRef, workspaceId])

  useEffect(() => { setSelected(undefined); if (prefix === undefined) setDismissed(undefined) }, [text, workspaceId, prefix])
  useEffect(() => {
    if (!active) { setSnapshot(undefined); return }
    let mounted = true, timer: ReturnType<typeof setTimeout> | undefined
    setSnapshot({ bridge, workspaceId, query, page: { items: [], total: 0, diagnostics: [] }, loading: true })
    const refresh = async () => {
      try {
        const response = await bridge.request({ kind: "desktop/resources/suggestions", workspaceId, query }) as ResourceSuggestionPage
        const page = response && Array.isArray(response.items) ? response : { items: [], total: 0, diagnostics: [] }
        if (mounted) setSnapshot({ bridge, workspaceId, query, page, loading: false })
      } catch (reason) {
        // Unreadable registries cannot prove that cached plugin rows remain available.
        if (mounted) setSnapshot({ bridge, workspaceId, query, page: { items: [], total: 0, diagnostics: [] }, loading: false, error: String(reason) })
      }
      if (mounted) timer = setTimeout(() => { void refresh() }, 500)
    }
    void refresh()
    return () => { mounted = false; clearTimeout(timer) }
  }, [bridge, workspaceId, query, active])

  const builtins: Suggestion[] = [
    ...(showCompact ? [{ name: "compact", description: t("壓縮目前會話上下文") }] : []),
    ...(workflows ? [{ name: "goal", description: t("目標與計畫") }, { name: "team", description: t("代理團隊") }, { name: "jobs", description: t("背景工作") }, { name: "reviews", description: t("代審") }] : []),
    ...(settings ? [{ name: "settings", description: t("設定") }] : []),
  ].map(row => ({ ...row, kind: "command", source: "builtin" }))
  const term = query.toLocaleLowerCase()
  const local = builtins.filter(row => (row.name + " " + (row.description ?? "")).toLocaleLowerCase().includes(term))
  const remote = (current?.page.items ?? []).filter(row => row.kind === "skill" || row.name !== "compact" && !builtins.some(builtin => builtin.name === row.name))
  const matches: Suggestion[] = [...local, ...remote.filter(row => row.kind === "command"), ...remote.filter(row => row.kind === "skill")]
  const found = matches.findIndex(row => identity(row) === selected)
  const index = found < 0 ? 0 : found
  const choose = (row: Suggestion) => row.kind === "skill" ? onSelect(row.name, "skill") : onSelect(row.name)
  useImperativeHandle(ref, () => ({ key(key) {
    if (!active) return false
    if (key === "Escape") { setDismissed(signature); return true }
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      if (matches.length) {
        const next = key === "Home" ? 0 : key === "End" ? matches.length - 1 : (index + (key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length
        setSelected(identity(matches[next]!))
      }
      return true
    }
    if (key === "Enter" || key === "Tab") {
      const row = matches[index]
      if (row) { choose(row); return true }
      return key === "Enter"
    }
    return false
  } }))

  const selectedId = matches[index] ? id + "-option-" + index : undefined
  useLayoutEffect(() => {
    if (!active) return
    const anchor = anchorRef?.current
    const position = () => {
      const rect = anchor?.getBoundingClientRect()
      const width = Math.max(160, Math.min(600, rect?.width || 420, window.innerWidth - 24))
      const left = Math.max(12, Math.min(rect?.left ?? 12, window.innerWidth - width - 12))
      if (!rect || !rect.height) { setPlacement({ left, bottom: 12, width, maxHeight: 380 }); return }
      const above = Math.max(0, rect.top - 20), below = Math.max(0, window.innerHeight - rect.bottom - 20)
      setPlacement(above >= below || above >= 260
        ? { left, width, bottom: window.innerHeight - rect.top + 8, maxHeight: Math.min(380, above) }
        : { left, width, top: rect.bottom + 8, maxHeight: Math.min(380, below) })
    }
    position()
    const observer = typeof ResizeObserver !== "undefined" && anchor ? new ResizeObserver(position) : undefined
    if (anchor) observer?.observe(anchor)
    window.addEventListener("resize", position)
    window.addEventListener("scroll", position, true)
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) setDismissed(signature) }
    document.addEventListener("pointerdown", outside)
    const removeEscape = listenForegroundEscape(panel.current, () => {
      setDismissed(signature)
      if (anchor && anchorIsVisible(anchor)) anchor.focus({ preventScroll: true })
    })
    return () => { observer?.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); document.removeEventListener("pointerdown", outside); removeEscape() }
  }, [active, anchorRef, signature])
  useEffect(() => { if (active && selectedId) document.getElementById(selectedId)?.scrollIntoView?.({ block: "nearest" }) }, [active, selectedId, selected])
  if (!active) return null
  const groups = [{ kind: "builtin", label: t("操作") }, { kind: "command", label: t("命令") }, { kind: "skill", label: t("技能") }] as const
  return createPortal(<div ref={panel} className="slash-command-menu" style={placement} role="dialog" aria-modal="false" aria-label={t("技能與命令")}>
    <div className="slash-command-heading"><Search size={14} aria-hidden="true" /><span>{query || t("技能與命令")}</span>{current?.loading || !current ? <LoaderCircle className="slash-command-spinner" size={14} aria-label={t("正在讀取…")} /> : <small>{matches.length}</small>}</div>
    {current?.error ? <p className="slash-command-message error-text" role="alert">{current.error}</p> : null}
    <div className="slash-command-list" role="listbox" aria-label={t("可用命令")} aria-activedescendant={selectedId}>
      {groups.map(group => {
        const rows = matches.map((row, i) => ({ row, i })).filter(({ row }) => group.kind === "builtin" ? row.source === "builtin" : row.source !== "builtin" && row.kind === group.kind)
        if (!rows.length) return null
        return <div key={group.kind} role="group" aria-label={group.label}>
          <div className="slash-command-group" role="presentation">{group.label}</div>
          {rows.map(({ row, i }) => <button id={id + "-option-" + i} className="slash-command-option" type="button" role="option" aria-selected={i === index} tabIndex={-1} key={identity(row)} onMouseDown={event => event.preventDefault()} onClick={() => choose(row)} onMouseMove={() => setSelected(identity(row))}>
            <span className="slash-command-icon" aria-hidden="true">{row.kind === "skill" ? <BookOpen size={17} /> : row.source === "builtin" ? <Command size={17} /> : <Terminal size={17} />}</span>
            <span className="slash-command-copy"><strong>{row.kind === "skill" ? "$" : "/"}{row.name}</strong>{row.description ? <span className="slash-command-description" title={row.description}>{row.description}</span> : null}{row.argumentHints ? <span className="slash-command-arguments">{row.argumentHints}</span> : null}</span>
            <span className="slash-command-source" title={row.pluginId ?? ""}>{row.source === "plugin" ? <><Puzzle size={11} aria-hidden="true" />{row.pluginId?.split("__").at(-1) || t("插件")}</> : t(row.source === "workspace" ? "專案" : row.source === "global" ? "全域" : "內建")}</span>
          </button>)}
        </div>
      })}
      {!matches.length ? <p className="slash-command-message" role="status">{current?.loading || !current ? t("正在讀取…") : t("沒有符合的已啟用命令或技能")}</p> : null}
    </div>
    {current && current.page.total > current.page.items.length ? <p className="slash-command-message">{t("輸入名稱或描述以縮小搜尋範圍。")}</p> : null}
    {current?.page.diagnostics.length ? <details className="slash-command-diagnostics"><summary>{t("載入診斷")}</summary>{current.page.diagnostics.map((message, i) => <p key={i}>{message}</p>)}</details> : null}
    <div className="slash-command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> {t("選擇")}</span><span><kbd>Enter</kbd> {t("帶入")}</span><span><kbd>Esc</kbd> {t("關閉")}</span></div>
  </div>, document.body)
})
