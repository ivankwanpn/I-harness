import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronDown } from "lucide-react"
import type { SessionModelSelection, SessionModelState } from "@i-harness/sdk"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
interface Route { id: string; displayName: string; configured?: boolean; auth?: { configured: boolean }; models: { id: string }[] }
export function SessionModelPicker({ bridge, workspaceId, current, disabled, onSelect }: { bridge: DesktopBridge; workspaceId: string; current?: SessionModelState; disabled: boolean; onSelect(selection: SessionModelSelection): Promise<void> }) {
  const t = useText(); const listId = useId()
  const [open, setOpen] = useState(false)
  const [routes, setRoutes] = useState<Route[]>([])
  const [provider, setProvider] = useState(current?.status === "ready" ? current.providerId : "")
  const [model, setModel] = useState(current?.status === "ready" ? current.modelId : "")
  const [effort, setEffort] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const [retry, setRetry] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const touched = useRef(false)
  const [placement, setPlacement] = useState({ right: 24, bottom: 80, maxHeight: 520 })
  const close = () => { setOpen(false); trigger.current?.focus() }
  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect) setPlacement({ right: Math.max(16, window.innerWidth - rect.right), bottom: Math.max(16, window.innerHeight - rect.top + 10), maxHeight: Math.max(180, rect.top - 24) })
    }
    position()
    window.addEventListener("resize", position)
    window.addEventListener("scroll", position, true)
    panel.current?.querySelector<HTMLSelectElement>("select")?.focus()
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close() } }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", escape)
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape) }
  }, [open])
  useEffect(() => {
    if (!open) return
    let active = true
    setError(undefined)
    void bridge.request({ kind: "desktop/provider/directory", workspaceId }).then((result) => {
      if (!active) return
      const all = result as Route[]
      setRoutes([...all].sort((a, b) => Number(Boolean(b.configured)) - Number(Boolean(a.configured))))
      const configured = all.filter((row) => row.configured || row.auth?.configured)
      if (!touched.current && current?.status !== "ready" && configured.length === 1) {
        setProvider(configured[0]!.id)
        if (configured[0]!.models.length === 1) setModel(configured[0]!.models[0]!.id)
      }
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, open, retry])
  return <div className="session-model-picker">
    <button ref={trigger} type="button" className="composer-model" disabled={disabled || busy} aria-expanded={open} aria-haspopup="dialog" onClick={() => { touched.current = false; setOpen(!open); setProvider(current?.status === "ready" ? current.providerId : ""); setModel(current?.status === "ready" ? current.modelId : "") }}>{current?.status === "ready" ? current.label : t("選擇模型")}<ChevronDown size={13} aria-hidden="true" /></button>
    {open ? createPortal(<div ref={panel} style={placement} className="model-picker-panel provider-editor" role="dialog" aria-label={t("選擇模型")}>
      <label>{t("提供商 ID")}<select disabled={busy} value={provider} onChange={(event) => { touched.current = true; setProvider(event.target.value); setModel("") }}><option value="">{t("未指定")}</option>{routes.map((route) => <option key={route.id} value={route.id}>{route.displayName}</option>)}</select></label>
      <label>{t("模型 ID")}<input disabled={busy} list={listId} value={model} onChange={(event) => { touched.current = true; setModel(event.target.value) }} /></label>
      <datalist id={listId}>{routes.find((route) => route.id === provider)?.models.map((row) => <option key={row.id} value={row.id} />)}</datalist>
      <label>{t("推理強度")}<select disabled={busy} value={effort} onChange={(event) => { touched.current = true; setEffort(event.target.value) }}><option value="">{t("未指定")}</option>{["off", "low", "medium", "high", "xhigh", "max"].map((value) => <option key={value}>{value}</option>)}</select></label>
      {error ? <p role="alert">{error}<button type="button" onClick={() => setRetry(retry + 1)}>{t("重試")}</button></p> : null}
      <div className="provider-actions"><button type="button" disabled={disabled || busy || !provider || !model.trim()} onClick={() => {
        if (locked.current) return
        locked.current = true; setBusy(true); setError(undefined)
        void onSelect({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) }).then(close).catch((reason: unknown) => setError(String(reason))).finally(() => { locked.current = false; setBusy(false) })
      }}>{t("套用模型")}</button><button type="button" disabled={busy} onClick={close}>{t("取消")}</button></div>
    </div>, document.body) : null}
  </div>
}
