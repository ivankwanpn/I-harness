import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Brain, Check, ChevronDown, Search } from "lucide-react"
import type { SessionModelSelection, SessionModelState } from "@i-harness/sdk"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale, useText } from "../design/i18n.ts"
import { listenForegroundEscape } from "../design/foreground-escape.ts"

export interface ModelDirectoryRoute { id: string; displayName: string; configured?: boolean; auth?: { configured: boolean }; models: { id: string; inputModalities?: string[] }[] }
type Route = ModelDirectoryRoute
type Panel = "model" | "effort" | null
const effortOptions = [
  { value: "", label: "Default" },
  { value: "off", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
] as const

export function SessionModelPicker({ bridge, workspaceId, current, disabled, onSelect }: { bridge: DesktopBridge; workspaceId: string; current?: SessionModelState; disabled: boolean; onSelect(selection: SessionModelSelection): Promise<void> }) {
  const t = useText()
  const en = useLocale(state => state.locale) === "en"
  const [panel, setPanel] = useState<Panel>(null)
  const [directory, setDirectory] = useState<{ bridge: DesktopBridge; workspaceId: string; rows: Route[] }>()
  const [loading, setLoading] = useState(true)
  const routes = directory?.bridge === bridge && directory.workspaceId === workspaceId ? directory.rows : undefined
  const [search, setSearch] = useState("")
  const [custom, setCustom] = useState(false)
  const [customProvider, setCustomProvider] = useState("")
  const [customModel, setCustomModel] = useState("")
  const [loadError, setLoadError] = useState<string>()
  const [applyError, setApplyError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const [retry, setRetry] = useState(0)
  const modelTrigger = useRef<HTMLButtonElement>(null)
  const effortTrigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState({ right: 16, bottom: 64, maxHeight: 480 })
  const ready = current?.status === "ready" ? current : undefined
  const effort = ready?.reasoningEffort ?? ""
  const error = applyError ?? loadError
  const effortLabel = effortOptions.find((option) => option.value === effort)?.label ?? "Default"
  const configured = (routes ?? []).filter((route) => route.configured || route.auth?.configured)
  const query = search.trim().toLocaleLowerCase()
  const visible = configured.map((route) => ({
    route,
    models: route.models.filter((model) => !query || `${route.id} ${route.displayName} ${model.id}`.toLocaleLowerCase().includes(query)),
  })).filter((group) => group.models.length)

  const close = () => {
    const trigger = panel === "model" ? modelTrigger : effortTrigger
    setPanel(null)
    trigger.current?.focus()
  }
  const toggle = (next: Exclude<Panel, null>) => {
    if (panel === next) { close(); return }
    setLoadError(undefined)
    setApplyError(undefined)
    setSearch("")
    setCustom(false)
    setCustomProvider(ready?.providerId ?? "")
    setCustomModel("")
    setPanel(next)
  }

  useLayoutEffect(() => {
    if (!panel) return
    const trigger = panel === "model" ? modelTrigger.current : effortTrigger.current
    const position = () => {
      const rect = trigger?.getBoundingClientRect()
      if (rect) setPlacement({ right: Math.max(12, window.innerWidth - rect.right), bottom: Math.max(12, window.innerHeight - rect.top + 8), maxHeight: Math.max(180, rect.top - 20) })
    }
    position()
    window.addEventListener("resize", position)
    window.addEventListener("scroll", position, true)
    popover.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus()
    if (panel === "effort") popover.current?.querySelector<HTMLButtonElement>(".model-effort-options button")?.focus()
    const outside = (event: PointerEvent) => { if (!popover.current?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) setPanel(null) }
    const removeEscape = listenForegroundEscape(popover.current, close, () => locked.current)
    document.addEventListener("pointerdown", outside)
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); document.removeEventListener("pointerdown", outside); removeEscape() }
  }, [panel])

  useEffect(() => {
    if (panel !== "model") return
    let active = true
    setLoading(true)
    void bridge.request({ kind: "desktop/provider/directory", workspaceId }).then((result) => {
      if (!active) return
      const rows = result as Route[]
      setDirectory({ bridge, workspaceId, rows })
      setLoadError(undefined)
      const available = rows.filter((route) => route.configured || route.auth?.configured)
      if (!ready && available.length === 1) setCustomProvider(available[0]!.id)
    }).catch((reason: unknown) => { if (active) setLoadError(String(reason)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bridge, workspaceId, panel, retry])

  const apply = (selection: SessionModelSelection) => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setLoadError(undefined)
    setApplyError(undefined)
    void onSelect(selection).then(close).catch((reason: unknown) => setApplyError(String(reason))).finally(() => { locked.current = false; setBusy(false) })
  }

  return <div className="session-model-picker">
    <button ref={modelTrigger} type="button" className="composer-model" title={ready?.label} disabled={disabled || busy} aria-expanded={panel === "model"} aria-haspopup="dialog" onClick={() => toggle("model")}>{ready?.modelId ?? t("選擇模型")}<ChevronDown size={13} aria-hidden="true" /></button>
    <button ref={effortTrigger} type="button" className="composer-model composer-effort" disabled={disabled || busy || !ready} aria-label={t("思考強度：{effort}", { effort: effortLabel })} title={t("思考強度：{effort}", { effort: effortLabel })} aria-expanded={panel === "effort"} aria-haspopup="dialog" onClick={() => toggle("effort")}><Brain size={14} aria-hidden="true" />{effortLabel}<ChevronDown size={13} aria-hidden="true" /></button>
    {panel ? createPortal(<div ref={popover} className={`model-picker-panel ${panel === "effort" ? "model-effort-panel" : ""}`} style={placement} role="dialog" aria-label={panel === "model" ? t("選擇模型") : t("思考強度")}>
      {panel === "model" ? <>
        <label className="model-picker-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label={t("搜尋模型")} placeholder={t("搜尋模型")} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <div className="model-picker-list">
          {loading && routes !== undefined ? <p className="muted" role="status">{en ? "Refreshing models…" : "正在更新模型清單…"}</p> : null}
          {routes === undefined && !loadError ? <p className="model-picker-empty" role="status">{en ? "Loading models…" : "讀取模型清單中…"}</p> : visible.length ? visible.map(({ route, models }) => <section key={route.id} className="model-picker-group" aria-label={route.displayName}>
            <div className="model-picker-group-title">{route.displayName}</div>
            {models.map((model) => <button key={model.id} type="button" disabled={busy} aria-pressed={ready?.providerId === route.id && ready.modelId === model.id} className="model-picker-option" onClick={() => apply({ provider: route.id, model: model.id })}><span>{model.id}</span>{ready?.providerId === route.id && ready.modelId === model.id ? <Check size={14} aria-hidden="true" /> : null}</button>)}
          </section>) : !loadError ? <p className="model-picker-empty">{configured.some(route => route.models.length) ? t("沒有符合的模型") : en ? "No models are configured. Open Models and providers in Settings." : "尚未設定可用模型；請到模型與提供商設定。"}</p> : null}
        </div>
        <button type="button" className="model-picker-custom-toggle" disabled={busy} onClick={() => setCustom(!custom)}>{t("自訂模型 ID")}</button>
        {custom ? <div className="model-picker-custom">
          <label>{t("提供商 ID")}<select value={customProvider} disabled={busy} onChange={(event) => setCustomProvider(event.target.value)}><option value="">{t("未指定")}</option>{configured.map((route) => <option key={route.id} value={route.id}>{route.displayName}</option>)}</select></label>
          <label>{t("模型 ID")}<input value={customModel} disabled={busy} onChange={(event) => setCustomModel(event.target.value)} /></label>
          <button type="button" disabled={busy || !customProvider || !customModel.trim()} onClick={() => apply({ provider: customProvider, model: customModel.trim() })}>{t("套用模型")}</button>
        </div> : null}
      </> : <div className="model-effort-options">{ready ? effortOptions.filter((option) => !option.value || ready.reasoningEfforts === undefined || ready.reasoningEfforts.includes(option.value)).map((option) => <button key={option.value} type="button" disabled={busy} aria-pressed={effort === option.value} onClick={() => apply({ provider: ready.providerId, model: ready.modelId, ...(ready.protocol ? { protocol: ready.protocol } : {}), ...(option.value ? { reasoningEffort: option.value } : {}) })}><span>{option.label}</span>{effort === option.value ? <Check size={14} aria-hidden="true" /> : null}</button>) : null}</div>}
      {error ? <p role="alert" className="model-picker-error error-text">{error}{loadError && !applyError ? <button type="button" onClick={() => setRetry(retry + 1)}>{t("重試")}</button> : null}</p> : null}
    </div>, document.body) : null}
  </div>
}
