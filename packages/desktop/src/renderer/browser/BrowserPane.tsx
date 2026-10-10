import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, RotateCw, Square, Plus, X } from "lucide-react"
import type { DesktopBridge, DesktopRequest } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { useNativeBrowserViewport } from "./useNativeBrowserViewport.ts"
import "./browser-pane.css"

interface Tab { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
interface View {
  bridge: DesktopBridge; workspaceId: string; tabs?: Tab[]; selected?: string
  address: string; busy: boolean; listError?: string; actionError?: string; nativeError?: string
}
interface Scope {
  bridge: DesktopBridge; workspaceId: string; active: boolean; locked: boolean; ticket: number
  read(preferred?: string): Promise<void>
}
const emptyView = (bridge: DesktopBridge, workspaceId: string): View => ({ bridge, workspaceId, address: "", busy: false })
const selectedTabs = new WeakMap<DesktopBridge, Map<string, string>>()

function rememberTab(bridge: DesktopBridge, workspaceId: string, id?: string) {
  const map = selectedTabs.get(bridge) ?? new Map<string, string>()
  selectedTabs.set(bridge, map)
  if (id) map.set(workspaceId, id)
  else map.delete(workspaceId)
}

export function BrowserPane({ bridge, workspaceId, visible = true }: { bridge: DesktopBridge; workspaceId: string; visible?: boolean }) {
  const t = useText()
  const viewport = useRef<HTMLDivElement>(null)
  const live = useRef<Scope>(undefined)
  const addressFocused = useRef(false)
  const [snapshot, setSnapshot] = useState(() => emptyView(bridge, workspaceId))
  const view = snapshot.bridge === bridge && snapshot.workspaceId === workspaceId ? snapshot : emptyView(bridge, workspaceId)
  const { selected, address, busy } = view
  const tabs = view.tabs ?? []
  const current = tabs.find(tab => tab.id === selected)
  const error = view.actionError ?? view.listError ?? view.nativeError ?? current?.error
  const patch = (scope: Scope, change: Partial<View>) => { if (scope.active && live.current === scope) setSnapshot(old => ({ ...old, ...change })) }

  useEffect(() => {
    const scope: Scope = { bridge, workspaceId, active: true, locked: false, ticket: 0, read: async () => {} }
    live.current = scope
    addressFocused.current = false
    setSnapshot(emptyView(bridge, workspaceId))
    let timer: ReturnType<typeof setTimeout> | undefined
    scope.read = async (preferred) => {
      const ticket = ++scope.ticket
      try {
        const rows = await bridge.request({ kind: "browser/list", workspaceId }) as Tab[]
        if (!scope.active || scope.ticket !== ticket) return
        const remembered = selectedTabs.get(bridge)?.get(workspaceId)
        setSnapshot(old => ({ ...old, tabs: rows, listError: undefined, selected: rows.some(row => row.id === preferred) ? preferred : rows.some(row => row.id === old.selected) ? old.selected : rows.some(row => row.id === remembered) ? remembered : rows[0]?.id }))
      } catch (reason) { if (scope.active && scope.ticket === ticket) patch(scope, { listError: String(reason) }) }
    }
    const poll = async () => {
      if (!scope.active) return
      if (!scope.locked) await scope.read()
      if (scope.active) timer = setTimeout(() => { void poll() }, 500)
    }
    void poll()
    return () => { scope.active = false; clearTimeout(timer) }
  }, [bridge, workspaceId])

  useEffect(() => { if (view.tabs !== undefined) rememberTab(bridge, workspaceId, selected) }, [bridge, workspaceId, view.tabs, selected])

  useEffect(() => {
    const scope = live.current
    if (scope && !addressFocused.current) patch(scope, { address: current?.url ?? "" })
  }, [selected, current?.url, bridge, workspaceId])
  useNativeBrowserViewport(bridge, workspaceId, viewport, {
    tabId: current?.id, visible,
    onError: nativeError => { const scope = live.current; if (scope) patch(scope, { nativeError }) },
  })

  const run = async (request: DesktopRequest) => {
    const scope = live.current
    if (!scope?.active || scope.locked || scope.bridge !== bridge || scope.workspaceId !== workspaceId) return
    scope.locked = true; scope.ticket++
    patch(scope, { busy: true, actionError: undefined })
    try {
      const result = await bridge.request(request) as { id?: string }
      if (!scope.active) return
      await scope.read(request.kind === "browser/open" && typeof result?.id === "string" ? result.id : undefined)
    } catch (reason) { patch(scope, { actionError: String(reason) }) }
    finally { scope.locked = false; patch(scope, { busy: false }) }
  }
  const changeAddress = (address: string) => { const scope = live.current; if (scope) patch(scope, { address }) }
  return <section className="browser-pane ih-control-scope" aria-label={t("瀏覽器")} aria-busy={busy || view.tabs === undefined && !view.listError}>
    <div className="browser-tabs" role="tablist" aria-label={t("瀏覽器分頁")}>
      {tabs.map(tab => <Button variant="ghost" size="small" role="tab" aria-selected={selected === tab.id} key={tab.id} title={tab.title || tab.url} onClick={() => { const scope = live.current; if (scope) patch(scope, { selected: tab.id }) }}>{tab.title || t("新分頁")}</Button>)}
      <Button variant="ghost" size="small" aria-label={t("新增分頁")} disabled={busy || tabs.length >= 8} icon={<Plus size={15} />} onClick={() => { void run({ kind: "browser/open", workspaceId }) }} />
    </div>
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); if (selected) void run({ kind: "browser/navigate", workspaceId, id: selected, url: address }) }}>
      <Button variant="ghost" size="small" aria-label={t("上一頁")} disabled={busy || !current?.canGoBack} icon={<ArrowLeft size={15} />} onClick={() => { if (selected) void run({ kind: "browser/action", workspaceId, id: selected, action: "back" }) }} />
      <Button variant="ghost" size="small" aria-label={t("下一頁")} disabled={busy || !current?.canGoForward} icon={<ArrowRight size={15} />} onClick={() => { if (selected) void run({ kind: "browser/action", workspaceId, id: selected, action: "forward" }) }} />
      <Button variant="ghost" size="small" aria-label={t(current?.loading ? "停止" : "重新整理")} disabled={busy || !selected} icon={current?.loading ? <Square size={15} /> : <RotateCw size={15} />} onClick={() => { if (selected) void run({ kind: "browser/action", workspaceId, id: selected, action: current?.loading ? "stop" : "reload" }) }} />
      <input aria-label={t("網址")} placeholder="https://" type="url" required maxLength={8192} value={address} disabled={!selected || busy} onFocus={() => { addressFocused.current = true }} onBlur={() => { addressFocused.current = false }} onChange={event => changeAddress(event.target.value)} />
      <Button type="submit" size="small" disabled={busy || !selected || !address.trim()}>{t("前往")}</Button>
      <Button variant="ghost" size="small" aria-label={t("關閉分頁")} disabled={busy || !selected} icon={<X size={15} />} onClick={() => { if (selected) void run({ kind: "browser/close", workspaceId, id: selected }) }} />
    </form>
    {error ? <p role="alert" className="browser-error">{error}{view.listError ? <Button size="small" disabled={busy} onClick={() => { void live.current?.read() }}>{t("重試")}</Button> : null}</p> : null}
    <div ref={viewport} className="browser-viewport">
      {view.tabs === undefined && !view.listError ? <p role="status" className="browser-state">{t("正在載入瀏覽器分頁…")}</p> : view.tabs?.length === 0 && !view.listError ? <p className="browser-state">{t("新增分頁並輸入網址以開始瀏覽。")}</p> : null}
    </div>
  </section>
}
