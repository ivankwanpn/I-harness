import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, RotateCw, Square, Plus, X } from "lucide-react"
import type { DesktopBridge, DesktopRequest } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
interface Tab { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
export function BrowserPane({ bridge, workspaceId, visible = true }: { bridge: DesktopBridge; workspaceId: string; visible?: boolean }) {
  const t = useText()
  const viewport = useRef<HTMLDivElement>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [selected, setSelected] = useState<string>()
  const [address, setAddress] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const addressFocused = useRef(false)
  const current = tabs.find((tab) => tab.id === selected)
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const rows = await bridge.request({ kind: "browser/list", workspaceId }) as Tab[]
        if (!active) return
        setTabs(rows); setSelected((old) => rows.some((row) => row.id === old) ? old : rows[0]?.id)
      } catch (reason) { if (active) setError(String(reason)) }
      if (active) timer = setTimeout(() => { void poll() }, 500)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [bridge, workspaceId])
  useEffect(() => { if (!addressFocused.current) setAddress(current?.url ?? "") }, [selected, current?.url])
  useEffect(() => {
    let active = true; let frame: number | undefined
    const hide = () => { void bridge.request({ kind: "browser/hide", workspaceId }).catch(() => undefined) }
    if (!visible || !selected) { hide(); return }
    const update = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!active) return
        const bounds = viewport.current?.getBoundingClientRect()
        if (document.hidden || !bounds || bounds.width < 1 || bounds.height < 1) { hide(); return }
        void bridge.request({ kind: "browser/show", workspaceId, id: selected, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }).catch((reason: unknown) => { if (active) setError(String(reason)) })
      })
    }
    const observer = new ResizeObserver(update)
    if (viewport.current) observer.observe(viewport.current)
    window.addEventListener("resize", update); window.addEventListener("scroll", update, true); document.addEventListener("visibilitychange", update)
    update()
    return () => { active = false; if (frame !== undefined) cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); document.removeEventListener("visibilitychange", update); hide() }
  }, [bridge, workspaceId, selected, visible])
  const run = async (request: DesktopRequest) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined)
    try {
      const result = await bridge.request(request) as { id?: string }
      const rows = await bridge.request({ kind: "browser/list", workspaceId }) as Tab[]
      setTabs(rows)
      if (request.kind === "browser/open" && result.id) setSelected(result.id)
      else setSelected((old) => rows.some((row) => row.id === old) ? old : rows[0]?.id)
    } catch (reason) { setError(String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <section className="browser-pane" aria-label={t("瀏覽器")}>
    <div className="browser-tabs" role="tablist" aria-label={t("瀏覽器分頁")}>{tabs.map((tab) => <button role="tab" aria-selected={selected === tab.id} key={tab.id} title={tab.title || tab.url} onClick={() => setSelected(tab.id)}>{tab.title || t("新分頁")}</button>)}<button aria-label={t("新增分頁")} disabled={busy || tabs.length >= 8} onClick={() => { void run({ kind: "browser/open", workspaceId }) }}><Plus size={15} /></button></div>
    <form className="browser-toolbar" onSubmit={(event) => { event.preventDefault(); if (selected) void run({ kind: "browser/navigate", workspaceId, id: selected, url: address }) }}>
      <button type="button" aria-label={t("上一頁")} disabled={busy || !current?.canGoBack} onClick={() => { if (selected) void run({ kind: "browser/action", workspaceId, id: selected, action: "back" }) }}><ArrowLeft size={15} /></button>
      <button type="button" aria-label={t("下一頁")} disabled={busy || !current?.canGoForward} onClick={() => { if (selected) void run({ kind: "browser/action", workspaceId, id: selected, action: "forward" }) }}><ArrowRight size={15} /></button>
      <button type="button" aria-label={t(current?.loading ? "停止" : "重新整理")} disabled={busy || !selected} onClick={() => { if (selected) void run({ kind: "browser/action", workspaceId, id: selected, action: current?.loading ? "stop" : "reload" }) }}>{current?.loading ? <Square size={15} /> : <RotateCw size={15} />}</button>
      <input aria-label={t("網址")} placeholder="https://" type="url" required maxLength={8192} value={address} disabled={!selected} onFocus={() => { addressFocused.current = true }} onBlur={() => { addressFocused.current = false }} onChange={(event) => setAddress(event.target.value)} />
      <button disabled={busy || !selected || !address.trim()}>{t("前往")}</button>
      <button type="button" aria-label={t("關閉分頁")} disabled={busy || !selected} onClick={() => { if (selected) void run({ kind: "browser/close", workspaceId, id: selected }) }}><X size={15} /></button>
    </form>
    {error || current?.error ? <p role="alert">{error ?? current?.error}</p> : null}
    <div ref={viewport} className="browser-viewport">{!selected ? <p>{t("新增分頁並輸入網址以開始瀏覽。")}</p> : null}</div>
  </section>
}
