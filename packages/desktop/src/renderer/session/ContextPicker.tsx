import { forwardRef, useEffect, useImperativeHandle, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { ContextItem, ContextPage } from "@i-harness/desktop-gateway/src/context-picker.ts"
import { useText } from "../design/i18n.ts"
export interface PickerKeyboard { key(key: string): boolean }
export const ContextPicker = forwardRef<PickerKeyboard, { bridge: DesktopBridge; workspaceId: string; sessionId?: string; projectId?: string; text: string; onSelect(item: ContextItem): void }>(function ContextPicker({ bridge, workspaceId, sessionId, projectId, text, onSelect }, ref) {
  const t = useText()
  const query = /(?:^|\s)@([^\s]*)$/.exec(text)?.[1]
  const [kind, setKind] = useState<"files" | "sessions">("files")
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<ContextPage>({ items: [], nextOffset: null })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string>()
  const signature = JSON.stringify([workspaceId, sessionId, projectId, text])
  const active = query !== undefined && signature !== dismissed
  useEffect(() => { if (query === undefined) setDismissed(undefined) }, [query])
  useEffect(() => { setOffset(0); setIndex(0); setPage({ items: [], nextOffset: null }) }, [query, kind, workspaceId, sessionId, projectId])
  useEffect(() => {
    if (!active) return
    let current = true
    setLoading(true); setError(undefined); setPage({ items: [], nextOffset: null })
    void bridge.request({ kind: "desktop/context/search", workspaceId, ...(sessionId ? { sessionId } : {}), ...(projectId ? { projectId } : {}), query: query!, contextKind: kind, offset }).then((result) => {
      if (current) { setPage(result as ContextPage); setIndex(0) }
    }).catch((reason) => { if (current) setError(String(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [bridge, workspaceId, sessionId, projectId, query, kind, offset, active])
  useImperativeHandle(ref, () => ({ key(key) {
    if (!active) return false
    if (key === "Escape") { setDismissed(signature); return true }
    if (key === "ArrowDown" || key === "ArrowUp") { setIndex((old) => page.items.length ? (old + (key === "ArrowDown" ? 1 : -1) + page.items.length) % page.items.length : 0); return true }
    if (key === "Enter" || key === "Tab") { const item = page.items[index]; if (!loading && item) onSelect(item); return true }
    return false
  } }))
  if (!active) return null
  return <div className="slash-commands context-picker">
    <div><button type="button" aria-pressed={kind === "files"} onClick={() => setKind("files")}>{t("檔案")}</button><button type="button" aria-pressed={kind === "sessions"} onClick={() => setKind("sessions")}>{t("會話")}</button></div>
    {error ? <p role="alert">{error}</p> : loading ? <p role="status">{t("搜尋中…")}</p> : page.items.length === 0 ? <p role="status">{t("沒有符合的引用")}</p> : null}
    <div role="listbox" aria-label={t("專案引用")}>{page.items.map((item, i) => <button type="button" role="option" aria-selected={i === index} key={JSON.stringify(item)} onClick={() => onSelect(item)}>{item.kind === "file" ? `${item.workspaceLabel ?? item.workspaceId}/${item.path}` : `${item.label} · ${item.workspaceId}/${item.sessionId}#${item.seq}`}</button>)}</div>
    {page.nextOffset !== null ? <button type="button" onClick={() => setOffset(page.nextOffset!)}>{t("下一頁")}</button> : null}
    {offset > 0 ? <button type="button" onClick={() => setOffset(Math.max(0, offset - 30))}>{t("上一頁")}</button> : null}
    {page.truncated ? <p>{t("結果已達搜尋上限，請縮小搜尋範圍。")}</p> : null}
  </div>
})
