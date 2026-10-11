import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { File, LockKeyhole, X } from "lucide-react"
import type { ProjectFileRef, ProjectFileRoot } from "../../../../desktop-gateway/src/project-files.ts"
import { EditorDraftStore, editorDraftKey, isDraftDirty } from "./editor-drafts.ts"
import { useProjectFilesText } from "./project-files-text.ts"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import "./EditorTabs.css"

export interface EditorTabsProps {
  roots: ProjectFileRoot[]
  /** Display-only history; never grants access to removed roots. */
  rootLabels?: Record<string, string>
  unknownRootLabel?: string
  externalTab?: { path: string; onClose(): void }
  store: EditorDraftStore
  onSave(ref: ProjectFileRef): Promise<boolean>
  onOpen?(ref: ProjectFileRef): void
}
export function EditorTabs({ roots, rootLabels = {}, unknownRootLabel, externalTab, store, onSave, onOpen }: EditorTabsProps) {
  const pf = useProjectFilesText()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [closing, setClosing] = useState<ProjectFileRef[]>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const [closingExternal, setClosingExternal] = useState<EditorTabsProps["externalTab"]>()
  const [focusKey, setFocusKey] = useState<string>()
  const [closeFocus, setCloseFocus] = useState<Element | null>(null)
  const tabButtons = useRef(new Map<string, HTMLButtonElement>())
  const tabStrip = useRef<HTMLDivElement>(null)
  const mounted = useRef(true), saving = useRef(false)
  const current = useRef({ roots, onSave, externalTab })
  current.current = { roots, onSave, externalTab }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (focusKey) { tabButtons.current.get(focusKey)?.focus(); setFocusKey(undefined) }
  }, [focusKey, state.tabs])
  const label = (ref: ProjectFileRef) => `${roots.find(root => root.workspaceId === ref.workspaceId)?.label ?? rootLabels[ref.workspaceId] ?? unknownRootLabel ?? pf("已移出的資料夾")}/${ref.path}`
  const activeKey = state.active ? editorDraftKey(state.active) : undefined
  const active = state.tabs.find(ref => editorDraftKey(ref) === activeKey)
  const dirtyTargets = (closing ?? []).filter(ref => isDraftDirty(store.get(ref)))
  const cannotSave = dirtyTargets.some(ref => !roots.some(root => root.workspaceId === ref.workspaceId) || !!store.get(ref)?.external)
  const closingCount = (closing?.length ?? 0) + (closingExternal ? 1 : 0)
  const externalKey = externalTab ? `external:${externalTab.path}` : undefined
  const selectedKey = externalKey ?? activeKey
  useEffect(() => {
    if (!closeFocus) return
    // A removed tab or confirmation dialog must not leave keyboard users on
    // document.body. Preserve focus when the dialog restored a surviving
    // trigger, or when another control still owns it.
    if ((!closeFocus.isConnected || closeFocus.matches(":disabled")) && document.activeElement === document.body) {
      const selected = selectedKey ? tabButtons.current.get(selectedKey) : undefined
      const target = selected ?? tabStrip.current
      target?.focus({ preventScroll: true })
    }
    setCloseFocus(null)
  }, [closeFocus, selectedKey])
  useLayoutEffect(() => {
    const strip = tabStrip.current
    if (!strip || !selectedKey) return
    const revealSelected = () => {
      const tab = tabButtons.current.get(selectedKey)?.parentElement
      if (!tab || strip.clientWidth <= 0) return
      const bounds = tab.getBoundingClientRect()
      if (bounds.width <= 0) return
      const left = strip.getBoundingClientRect().left + strip.clientLeft
      const right = left + strip.clientWidth
      const shift = bounds.left < left || bounds.width > strip.clientWidth ? bounds.left - left : bounds.right > right ? bounds.right - right : 0
      // Only this horizontal strip moves. scrollIntoView would also move the
      // surrounding workbench; focusing here would steal editor input focus.
      if (shift) strip.scrollLeft += shift
    }
    revealSelected()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(revealSelected)
    observer?.observe(strip)
    window.addEventListener("resize", revealSelected)
    return () => { observer?.disconnect(); window.removeEventListener("resize", revealSelected) }
  }, [selectedKey, state.tabs.length])

  function commitClose(targets: ProjectFileRef[], choice: "keep" | "discard", capturedExternal?: EditorTabsProps["externalTab"], focused = document.activeElement) {
    setCloseFocus(focused)
    const before = store.getSnapshot(), keys = new Set(targets.map(editorDraftKey))
    const index = before.active ? before.tabs.findIndex(ref => editorDraftKey(ref) === editorDraftKey(before.active!)) : -1
    const neighbor = index >= 0 && keys.has(editorDraftKey(before.tabs[index]!))
      ? before.tabs.slice(index + 1).find(ref => !keys.has(editorDraftKey(ref))) ?? [...before.tabs.slice(0, index)].reverse().find(ref => !keys.has(editorDraftKey(ref)))
      : undefined
    for (const target of targets) if (before.tabs.some(ref => editorDraftKey(ref) === editorDraftKey(target))) store.close(target, choice)
    const closesExternal = !!capturedExternal && current.current.externalTab?.path === capturedExternal.path
    if (neighbor) store.open(neighbor)
    // A new external navigation is a different target from the preview the
    // user originally included in the batch, even while this dialog is open.
    if (closesExternal) capturedExternal.onClose()
    setClosing(undefined); setClosingExternal(undefined)
  }
  function close(targets: readonly ProjectFileRef[], capturedExternal?: EditorTabsProps["externalTab"]) {
    if (saving.current || closing || (!targets.length && !capturedExternal)) return
    const snapshot = targets.map(ref => ({ ...ref }))
    if (snapshot.some(ref => isDraftDirty(store.get(ref)))) { setClosing(snapshot); setClosingExternal(capturedExternal); setError(undefined) }
    else commitClose(snapshot, "discard", capturedExternal)
  }
  async function saveClose(targets: ProjectFileRef[], capturedExternal?: EditorTabsProps["externalTab"]) {
    if (saving.current) return
    const focused = document.activeElement
    saving.current = true; setBusy(true); setError(undefined)
    // Tabs stay open until every save succeeds. Recheck the complete target
    // set after awaits so edits arriving during a save cannot be closed away.
    const initial = new Map(targets.map(ref => [editorDraftKey(ref), store.get(ref)]))
    try {
      for (const ref of targets) {
        if (!mounted.current) return
        const draft = store.get(ref)
        if (!isDraftDirty(draft)) continue
        if (!current.current.roots.some(root => root.workspaceId === ref.workspaceId) || draft?.external) throw new Error("請先處理外部變更或已移出的資料夾。")
        if (!await current.current.onSave(ref)) throw new Error("未能儲存；分頁和草稿已保留。")
      }
      if (!mounted.current) return
      for (const ref of targets) {
        const draft = store.get(ref), original = initial.get(editorDraftKey(ref))
        if (isDraftDirty(draft) || draft?.external || (original && draft?.text !== original.text)) throw new Error("儲存期間內容已變更；分頁和草稿已保留。")
        if (isDraftDirty(original) && !current.current.roots.some(root => root.workspaceId === ref.workspaceId)) throw new Error("請先處理外部變更或已移出的資料夾。")
      }
      commitClose(targets, "keep", capturedExternal, focused)
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { saving.current = false; if (mounted.current) setBusy(false) }
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = state.tabs.length + (externalTab ? 1 : 0), last = count - 1
    const next = event.key === "ArrowRight" ? (index + 1) % count : event.key === "ArrowLeft" ? (index + last) % count : event.key === "Home" ? 0 : event.key === "End" ? last : undefined
    if (next !== undefined) {
      event.preventDefault()
      if (next === state.tabs.length && externalKey) setFocusKey(externalKey)
      else {
        const target = state.tabs[next]!
        if (onOpen) onOpen(target); else { externalTab?.onClose(); store.open(target) }
        setFocusKey(editorDraftKey(target))
      }
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") {
      event.preventDefault(); event.stopPropagation()
      if (index === state.tabs.length) close([], externalTab); else close([state.tabs[index]!])
    }
  }
  return <>
    <div className="editor-tabs-shell">
      <div className="editor-tabs" ref={tabStrip} role="tablist" tabIndex={-1} aria-label={pf("來源檔案分頁")}>{state.tabs.map((ref, index) => {
        const key = editorDraftKey(ref), dirty = isDraftDirty(store.get(ref)), fullLabel = label(ref)
        return <div className={`editor-tab${!externalTab && activeKey === key ? " editor-tab-active" : ""}`} key={key}>
          <button type="button" role="tab" ref={node => { if (node) tabButtons.current.set(key, node); else tabButtons.current.delete(key) }} tabIndex={!externalTab && (activeKey === key || !active && index === 0) ? 0 : -1} aria-selected={!externalTab && activeKey === key} aria-label={`${fullLabel}${dirty ? " ●" : ""}`} title={fullLabel} onKeyDown={event => tabKey(event, index)} onClick={() => { if (onOpen) onOpen(ref); else { externalTab?.onClose(); store.open(ref) } }}>
            <File size={14} aria-hidden="true" /><span className="editor-tab-name">{ref.path.split(/[\\/]/).at(-1)}</span>{dirty ? <i className="editor-tab-dirty" aria-hidden="true" /> : null}
          </button>
          <button type="button" className="editor-tab-close" disabled={busy || !!closing} title={pf("關閉 {path}", { path: fullLabel })} aria-label={pf("關閉 {path}", { path: fullLabel })} onClick={() => close([ref])}><X size={14} aria-hidden="true" /></button>
        </div>
      })}{externalTab && <div className="editor-tab editor-tab-active editor-tab-external">
        <button type="button" role="tab" aria-selected="true" aria-label={externalTab.path} title={externalTab.path} ref={node => { if (node) tabButtons.current.set(externalKey!, node); else tabButtons.current.delete(externalKey!) }} onKeyDown={event => tabKey(event, state.tabs.length)}><File size={14} aria-hidden="true" /><span className="editor-tab-name">{externalTab.path.split(/[\\/]/).at(-1)}</span><LockKeyhole size={12} aria-label={pf("唯讀")} /></button>
        <button type="button" className="editor-tab-close" disabled={busy || !!closing} title={pf("關閉 {path}", { path: externalTab.path })} aria-label={pf("關閉 {path}", { path: externalTab.path })} onClick={() => close([], externalTab)}><X size={14} aria-hidden="true" /></button>
      </div>}</div>
    </div>
    {closing ? <SettingsDialog className="editor-tabs-close-dialog" title={closingCount === 1 ? pf("關閉未儲存檔案 {path}", { path: label(closing[0]!) }) : pf("關閉 {count} 個檔案", { count: String(closingCount) })} closeLabel={pf("關閉對話框")} busy={busy} initialFocusSelector=".editor-tabs-dialog-cancel" onClose={() => { setClosing(undefined); setClosingExternal(undefined) }}>
      <p>{closing.length === 1 ? pf("{path} 有未儲存內容。", { path: label(closing[0]!) }) : pf("其中 {count} 個檔案有未儲存內容。", { count: String(dirtyTargets.length) })}</p>
      {closingCount > 1 ? <ul className="editor-tabs-close-list">{closing.map(ref => <li key={editorDraftKey(ref)}>{label(ref)}{isDraftDirty(store.get(ref)) ? " ●" : ""}</li>)}{closingExternal && <li>{closingExternal.path} · {pf("唯讀")}</li>}</ul> : null}
      <p className="editor-tabs-close-note">{pf("關閉分頁不會刪除磁碟上的檔案。")}</p>
      {cannotSave ? <p className="editor-tabs-close-note">{pf("請先處理外部變更或已移出的資料夾。")}</p> : null}
      {error ? <p role="alert">{pf(error)}</p> : null}
      <div className="editor-tabs-close-actions">
        <button type="button" disabled={busy || cannotSave} onClick={() => void saveClose(closing, closingExternal)}>{pf("儲存並關閉")}</button>
        <button type="button" disabled={busy} onClick={() => commitClose(closing, "keep", closingExternal)}>{pf("保留草稿並關閉")}</button>
        <button type="button" className="editor-tabs-discard" disabled={busy} onClick={() => commitClose(closing, "discard", closingExternal)}>{pf("捨棄草稿並關閉")}</button>
        <button type="button" className="editor-tabs-dialog-cancel" disabled={busy} onClick={() => { setClosing(undefined); setClosingExternal(undefined) }}>{pf("取消")}</button>
      </div>
    </SettingsDialog> : null}
  </>
}
