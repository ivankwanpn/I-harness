import { useEffect, useRef, useState } from "react"
import type { HistoryRange } from "@i-harness/sdk"
import type { HistorySelection } from "./SessionSearch.tsx"
import { HISTORY_PAGE_SIZE, historyViewport, pageHistoryViewport, type HistoryViewport } from "./event-window.ts"
import { projectHistoryTimeline } from "./project.ts"
import { Timeline } from "./Timeline.tsx"
import type { FileNavigation } from "./file-navigation.ts"
import { useLocale } from "../design/i18n.ts"
export interface HistoryRequest { kind: "session/history"; workspaceId: string; sessionId: string; afterSeq: number; limit: number }
export interface SessionHistoryViewProps {
  selection: HistorySelection
  request(request: HistoryRequest): Promise<HistoryRange>
  navigation?: FileNavigation
  onLatest(): void
}
/** Read-only durable window, independent from live replay and notification cursors. */
export function SessionHistoryView({ selection, request, navigation, onLatest }: SessionHistoryViewProps) {
  const english = useLocale(state => state.locale) === "en"
  const c = (zh: string, en: string) => english ? en : zh
  const [state, setState] = useState<HistoryViewport>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const lock = useRef(false)
  const load = (afterSeq: number) => request({ kind: "session/history", workspaceId: selection.workspaceId, sessionId: selection.sessionId, afterSeq, limit: HISTORY_PAGE_SIZE })
  useEffect(() => {
    const ticket = ++generation.current
    setState(undefined); setError(undefined); setBusy(true); lock.current = false
    const start = Math.max(0, selection.seq - Math.floor(HISTORY_PAGE_SIZE / 2))
    if (!Number.isSafeInteger(selection.seq) || selection.seq < 0) { setError("搜尋位置無效"); setBusy(false); return }
    void load(start).then(page => {
      if (ticket !== generation.current) return
      setState(historyViewport(page, start))
      if (!page.events.some(event => event.seq === selection.seq)) setError("搜尋內容已變更，請重新搜尋")
    }, error => { if (ticket === generation.current) setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (ticket === generation.current) setBusy(false) })
    return () => { generation.current++ }
  }, [selection.workspaceId, selection.sessionId, selection.seq, request])
  async function page(direction: "before" | "after") {
    if (!state || lock.current) return
    const ticket = generation.current
    lock.current = true; setBusy(true); setError(undefined)
    const start = direction === "before" ? Math.max(0, state.startSeq - HISTORY_PAGE_SIZE) : state.endSeq
    try { const result = await load(start); if (ticket === generation.current) setState(current => current ? pageHistoryViewport(current, result, start, direction) : current) }
    catch (error) { if (ticket === generation.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (ticket === generation.current) { lock.current = false; setBusy(false) } }
  }
  return <section className="session-history-view" aria-label={c("搜尋命中歷史", "Search result history")} style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
    <div className="provider-actions"><button disabled={busy || !state?.hasBefore} onClick={() => { void page("before") }}>{c("載入較早內容", "Load earlier content")}</button><span title={String(selection.seq)}>{c("搜尋命中", "Search result")}</span><button disabled={busy || !state?.hasAfter} onClick={() => { void page("after") }}>{c("載入較後內容", "Load later content")}</button><button onClick={onLatest}>{c("回到最新內容", "Return to latest content")}</button></div>
    {busy ? <p role="status">{c("正在載入歷史…", "Loading history…")}</p> : null}
    {error ? <p role="alert">{error === "搜尋位置無效" ? c(error, "Invalid search position") : error === "搜尋內容已變更，請重新搜尋" ? c(error, "Search content changed; search again") : error}</p> : null}
    {state ? <Timeline key={`${selection.workspaceId}:${selection.sessionId}:${selection.seq}`} rows={projectHistoryTimeline(state.events)} navigation={navigation} targetSeq={selection.seq} historical /> : null}
  </section>
}
