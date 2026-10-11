import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { SessionContextState } from "@i-harness/sdk"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { listenForegroundEscape } from "../design/foreground-escape.ts"
import "./ContextUsage.css"

const refreshDelay = 250
const refreshInterval = 1000
const hoverCloseDelay = 120
const contextEvents = new Set(["user/message", "assistant/message", "tool/call", "tool/result", "turn/end", "step/end", "compaction/start", "compaction/end", "compaction/summary", "compaction/reset", "compaction/prune", "rewind/point"])
type Estimate = { bridge: DesktopBridge; workspaceId: string; sessionId: string; refreshKey?: string; state?: SessionContextState; error?: string; loading: boolean }
type RefreshControl = { key?: string; invalidate(key: string | undefined, immediate?: boolean): void }
type PopupState = { bridge: DesktopBridge; workspaceId: string; sessionId: string; mode: "hover" | "explicit" }

/** Reject unknown or malformed readings instead of presenting fabricated zero usage. */
function contextState(value: unknown): SessionContextState {
  const candidate = value !== null && typeof value === "object" ? value as Partial<Extract<SessionContextState, { kind: "ready" }>> & { reason?: unknown } : undefined
  if (candidate?.kind === "ready" && typeof candidate.estimatedTokens === "number" && Number.isFinite(candidate.estimatedTokens) && candidate.estimatedTokens >= 0
    && typeof candidate.contextWindow === "number" && Number.isFinite(candidate.contextWindow) && candidate.contextWindow > 0
    && Number.isFinite(candidate.estimatedTokens / candidate.contextWindow * 100)) {
    const roles = candidate.roleTokens
    const validRoles = roles && [roles.user, roles.assistant, roles.tool].every(tokens => typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0)
    return { kind: "ready", estimatedTokens: candidate.estimatedTokens, contextWindow: candidate.contextWindow, ...(validRoles ? { roleTokens: roles } : {}) }
  }
  return { kind: "unavailable", reason: typeof candidate?.reason === "string" ? candidate.reason : "" }
}

/** Read-only token-meter estimates refreshed at durable session boundaries. */
export function ContextUsage({ bridge, workspaceId, sessionId, refreshKey }: { bridge: DesktopBridge; workspaceId: string; sessionId: string; refreshKey?: string }) {
  const t = useText()
  const panelId = useId()
  const readingId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const refresh = useRef<RefreshControl | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latestKey = useRef(refreshKey)
  latestKey.current = refreshKey
  const [popup, setPopup] = useState<PopupState>()
  const open = popup?.bridge === bridge && popup.workspaceId === workspaceId && popup.sessionId === sessionId
  const mode = open ? popup.mode : undefined
  const [estimate, setEstimate] = useState<Estimate>()
  const [placement, setPlacement] = useState({ right: 24, bottom: 72 })
  function cancelClose() { clearTimeout(closeTimer.current); closeTimer.current = undefined }
  function closePopup(returnFocus = false) {
    cancelClose()
    const focused = document.activeElement
    if (returnFocus && (panel.current?.contains(focused) || mode === "explicit" && focused === document.body)) trigger.current?.focus()
    setPopup(undefined)
  }
  function preview() {
    cancelClose()
    setPopup(previous => previous?.bridge === bridge && previous.workspaceId === workspaceId && previous.sessionId === sessionId
      ? previous : { bridge, workspaceId, sessionId, mode: "hover" })
  }
  function scheduleClose() {
    if (!open) return
    cancelClose()
    closeTimer.current = setTimeout(() => closePopup(true), hoverCloseDelay)
  }
  function activate() {
    cancelClose()
    if (open && mode === "explicit") closePopup(true)
    else setPopup({ bridge, workspaceId, sessionId, mode: "explicit" })
  }
  useLayoutEffect(() => {
    cancelClose()
    setPopup(undefined)
    return cancelClose
  }, [bridge, workspaceId, sessionId])
  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect) setPlacement({ right: Math.max(16, window.innerWidth - rect.right), bottom: Math.max(16, window.innerHeight - rect.top + 10) })
    }
    position()
    if (mode === "explicit") panel.current?.focus()
    window.addEventListener("resize", position)
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) closePopup() }
    const removeEscape = listenForegroundEscape(panel.current, () => { closePopup(true); if (mode === "explicit") trigger.current?.focus() })
    document.addEventListener("pointerdown", dismiss)
    return () => { window.removeEventListener("resize", position); document.removeEventListener("pointerdown", dismiss); removeEscape() }
  }, [open, mode])
  useEffect(() => {
    let active = true
    let running = false
    let dirty = false
    let immediate = false
    let revision = 0
    let lastStarted = 0
    let disconnected: { message: string } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const control: RefreshControl = {
      key: latestKey.current,
      invalidate(key, urgent = false) {
        if (!active) return
        control.key = key
        revision++
        // Keep operation/model changes scoped without restarting an offline gateway.
        if (disconnected && !urgent) {
          setEstimate({ bridge, workspaceId, sessionId, refreshKey: key, error: disconnected.message, loading: false })
          return
        }
        if (urgent) disconnected = undefined
        setEstimate({ bridge, workspaceId, sessionId, refreshKey: key, loading: true })
        schedule(urgent)
      },
    }
    const read = async () => {
      if (!active || disconnected || running) return
      clearTimeout(timer); timer = undefined
      running = true; dirty = false; immediate = false; lastStarted = Date.now()
      const ticket = revision
      const key = control.key
      const scope = { bridge, workspaceId, sessionId, refreshKey: key }
      setEstimate(previous => previous?.bridge === bridge && previous.workspaceId === workspaceId && previous.sessionId === sessionId && previous.refreshKey === key
        ? { ...previous, error: undefined, loading: true } : { ...scope, loading: true })
      try {
        const value = await bridge.request({ kind: "session/context", workspaceId, sessionId })
        if (active && ticket === revision) setEstimate({ ...scope, state: contextState(value), loading: false })
      } catch (reason) {
        if (active && ticket === revision) setEstimate({ ...scope, error: reason instanceof Error ? reason.message : String(reason), loading: false })
      } finally {
        running = false
        if (active && dirty) schedule()
      }
    }
    function schedule(urgent = false) {
      if (!active || disconnected) return
      dirty = true; immediate ||= urgent
      if (running) return
      if (immediate) { clearTimeout(timer); timer = undefined; void read(); return }
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; void read() }, Math.max(refreshDelay, refreshInterval - (Date.now() - lastStarted)))
    }
    refresh.current = control
    const mountRevision = revision
    const unsubscribe = bridge.onEvent(message => {
      if (!active || message.kind === "window/state" || message.workspaceId !== workspaceId) return
      if (message.kind === "sdk/disconnected") {
        disconnected = { message: message.message }
        revision++; dirty = false; immediate = false
        clearTimeout(timer); timer = undefined
        setEstimate({ bridge, workspaceId, sessionId, refreshKey: control.key, error: message.message, loading: false })
        return
      }
      if (disconnected) return
      const params = message.params as { sessionId?: unknown; event?: { type?: unknown } } | undefined
      if (params?.sessionId !== sessionId) return
      if (message.method === "session/status" || message.method === "session/event" && typeof params.event?.type === "string" && contextEvents.has(params.event.type)) schedule()
    })
    // StrictMode tears down its first effect before this read; a disconnect or
    // model change can also invalidate the mount request before it starts.
    void Promise.resolve().then(() => { if (revision === mountRevision) return read() })
    return () => { active = false; clearTimeout(timer); unsubscribe(); if (refresh.current === control) refresh.current = undefined }
  }, [bridge, workspaceId, sessionId])
  useEffect(() => {
    if (refresh.current && refresh.current.key !== refreshKey) refresh.current.invalidate(refreshKey)
  }, [bridge, workspaceId, sessionId, refreshKey])
  const current = estimate?.bridge === bridge && estimate.workspaceId === workspaceId && estimate.sessionId === sessionId && estimate.refreshKey === refreshKey ? estimate : undefined
  const state = current?.state
  const error = current?.error
  const ready = state?.kind === "ready" ? state : undefined
  const roleTokens = ready?.roleTokens
  const percent = ready ? ready.estimatedTokens / ready.contextWindow * 100 : undefined
  const reading = percent === undefined ? "—" : ready!.estimatedTokens > 0 && percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`
  const number = (value: number) => new Intl.NumberFormat("en-US").format(value)
  return <>
    <button ref={trigger} type="button" className="icon-button context-usage-trigger" aria-label={t("上下文容量")} aria-describedby={readingId} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} title={open ? undefined : `${t("估算上下文容量")} · ${reading}`} onClick={activate}
      onMouseEnter={preview} onMouseLeave={scheduleClose} onPointerEnter={event => { if (event.pointerType !== "touch") preview() }} onPointerLeave={event => { if (event.pointerType !== "touch") scheduleClose() }}>
      <svg className="context-usage-gauge" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle className="context-usage-gauge-track" cx="8" cy="8" r="6" />
        {percent !== undefined && percent > 0 ? <circle className="context-usage-gauge-fill" cx="8" cy="8" r="6" pathLength="100" strokeDasharray={`${Math.min(percent, 100)} 100`} transform="rotate(-90 8 8)" /> : null}
      </svg>
      <span id={readingId} className="context-usage-reading">{reading}</span>
    </button>
    {open ? createPortal(<div id={panelId} ref={panel} tabIndex={-1} className="context-usage-popover" style={placement} role="dialog" aria-label={t("上下文容量")}
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose} onPointerEnter={cancelClose} onPointerLeave={event => { if (event.pointerType !== "touch") scheduleClose() }}>
      <strong>{t("估算上下文容量")}</strong>
      {error !== undefined || state?.kind === "unavailable" ? <div><p role={error !== undefined ? "alert" : undefined}>{error || state?.kind === "unavailable" && state.reason || t("無法取得上下文容量。")}</p><button type="button" disabled={current?.loading} onClick={() => refresh.current?.invalidate(refreshKey, true)}>{t("重試")}</button></div> : ready ? <>
        <p>{number(ready.estimatedTokens)} / {number(ready.contextWindow)} ({reading})</p>
        <progress max={ready.contextWindow} value={Math.min(ready.estimatedTokens, ready.contextWindow)} aria-label={t("估算已用 Token")} />
        {roleTokens ? <div className="context-usage-breakdown" aria-label={t("訊息來源")}>
          {(["user", "assistant", "tool"] as const).map((role) => <div className="context-usage-role" key={role} data-role={role}><span>{t(role === "user" ? "使用者訊息" : role === "assistant" ? "助手訊息" : "工具訊息")}</span><output>{number(roleTokens[role])}</output></div>)}
        </div> : null}
        <small>{t("根據目前可見的模型訊息估算；不是供應商帳單或快取命中率。")}</small>
      </> : <p>{t("讀取上下文容量中…")}</p>}
    </div>, document.body) : null}
  </>
}
