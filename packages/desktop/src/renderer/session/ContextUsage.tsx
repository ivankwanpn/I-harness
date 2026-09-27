import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CircleGauge } from "lucide-react"
import type { SessionContextState } from "@i-harness/sdk"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"

/** A read-only estimate from the backend's token meter, loaded only on demand. */
export function ContextUsage({ bridge, workspaceId, sessionId }: { bridge: DesktopBridge; workspaceId: string; sessionId: string }) {
  const t = useText()
  const panelId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<SessionContextState>()
  const [error, setError] = useState<string>()
  const [placement, setPlacement] = useState({ right: 24, bottom: 72 })
  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect) setPlacement({ right: Math.max(16, window.innerWidth - rect.right), bottom: Math.max(16, window.innerHeight - rect.top + 10) })
    }
    position()
    panel.current?.focus()
    window.addEventListener("resize", position)
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus() } }
    document.addEventListener("pointerdown", dismiss)
    document.addEventListener("keydown", escape)
    return () => { window.removeEventListener("resize", position); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape) }
  }, [open])
  useEffect(() => {
    if (!open) return
    let active = true
    setState(undefined); setError(undefined)
    void bridge.request({ kind: "session/context", workspaceId, sessionId }).then((value) => { if (active) setState(value as SessionContextState) }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, sessionId, open])
  const ready = state?.kind === "ready" ? state : undefined
  const roleTokens = ready?.roleTokens
  const percent = ready ? (ready.estimatedTokens / ready.contextWindow * 100).toFixed(1) : undefined
  const number = (value: number) => new Intl.NumberFormat("en-US").format(value)
  return <>
    <button ref={trigger} type="button" className="icon-button context-usage-trigger" aria-label={t("上下文容量")} aria-expanded={open} aria-controls={open ? panelId : undefined} title={t("上下文容量")} onClick={() => setOpen((value) => !value)}><CircleGauge size={17} /></button>
    {open ? createPortal(<div id={panelId} ref={panel} tabIndex={-1} className="context-usage-popover" style={placement} role="dialog" aria-label={t("上下文容量")}>
      <strong>{t("估算上下文容量")}</strong>
      {error ? <p role="alert">{error}</p> : ready ? <>
        <p>{number(ready.estimatedTokens)} / {number(ready.contextWindow)} ({percent}%)</p>
        <progress max={ready.contextWindow} value={Math.min(ready.estimatedTokens, ready.contextWindow)} aria-label={t("估算已用 Token")} />
        {roleTokens ? <div className="context-usage-breakdown" aria-label={t("訊息來源")}>
          {(["user", "assistant", "tool"] as const).map((role) => <div className="context-usage-role" key={role} data-role={role}><span>{t(role === "user" ? "使用者訊息" : role === "assistant" ? "助手訊息" : "工具訊息")}</span><output>{number(roleTokens[role])}</output></div>)}
        </div> : null}
        <small>{t("根據目前可見的模型訊息估算；不是供應商帳單或快取命中率。")}</small>
      </> : state?.kind === "unavailable" ? <p>{state.reason}</p> : <p>{t("讀取上下文容量中…")}</p>}
    </div>, document.body) : null}
  </>
}
