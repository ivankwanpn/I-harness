import { useEffect, useId, useRef, useState } from "react"
import type { SessionModelSelection, SessionModelState } from "@i-harness/sdk"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
interface Route { id: string; displayName: string; models: { id: string }[] }
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
  useEffect(() => {
    if (!open) return
    let active = true
    setError(undefined)
    void bridge.request({ kind: "desktop/provider/directory", workspaceId }).then((result) => {
      if (active) setRoutes(result as Route[])
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, open, retry])
  return <div className="session-model-picker">
    <button type="button" className="composer-model" disabled={disabled || busy} aria-expanded={open} onClick={() => { setOpen(!open); setProvider(current?.status === "ready" ? current.providerId : ""); setModel(current?.status === "ready" ? current.modelId : "") }}>{current?.status === "ready" ? current.label : t("選擇模型")}</button>
    {open ? <div className="model-picker-panel provider-editor" role="dialog" aria-label={t("選擇模型")}>
      <label>{t("提供商 ID")}<select disabled={busy} value={provider} onChange={(event) => { setProvider(event.target.value); setModel("") }}><option value="">{t("未指定")}</option>{routes.map((route) => <option key={route.id} value={route.id}>{route.displayName}</option>)}</select></label>
      <label>{t("模型 ID")}<input disabled={busy} list={listId} value={model} onChange={(event) => setModel(event.target.value)} /></label>
      <datalist id={listId}>{routes.find((route) => route.id === provider)?.models.map((row) => <option key={row.id} value={row.id} />)}</datalist>
      <label>{t("推理強度")}<select disabled={busy} value={effort} onChange={(event) => setEffort(event.target.value)}><option value="">{t("未指定")}</option>{["off", "low", "medium", "high", "xhigh", "max"].map((value) => <option key={value}>{value}</option>)}</select></label>
      {error ? <p role="alert">{error}<button type="button" onClick={() => setRetry(retry + 1)}>{t("重試")}</button></p> : null}
      <div className="provider-actions"><button type="button" disabled={disabled || busy || !provider || !model.trim()} onClick={() => {
        if (locked.current) return
        locked.current = true; setBusy(true); setError(undefined)
        void onSelect({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) }).then(() => setOpen(false)).catch((reason: unknown) => setError(String(reason))).finally(() => { locked.current = false; setBusy(false) })
      }}>{t("套用模型")}</button><button type="button" disabled={busy} onClick={() => setOpen(false)}>{t("取消")}</button></div>
    </div> : null}
  </div>
}
