import { useCallback, useEffect, useRef, useState } from "react"
import type { HistoryRange } from "@i-harness/sdk"
import type { HistorySelection } from "./SessionSearch.tsx"
import { HISTORY_PAGE_SIZE, historyViewport, pageHistoryViewport, type HistoryViewport } from "./event-window.ts"
import type { HistoryPageRequest, HistoryReadScope } from "./history.ts"
import { projectHistoryTimeline } from "./project.ts"
import type { RecordedResultReader } from "./result-pages.ts"
import { Timeline } from "./Timeline.tsx"
import type { FileNavigation } from "./file-navigation.ts"
import { useLocale } from "../design/i18n.ts"
export interface HistoryRequest extends HistoryPageRequest { kind: "session/history"; workspaceId: string; sessionId: string }
export interface SessionHistoryViewProps {
  resultReader?: RecordedResultReader
  selection: HistorySelection
  request(request: HistoryRequest): Promise<HistoryRange>
  readScope?: HistoryReadScope
  navigation?: FileNavigation
  onForkAt?(selection: HistorySelection): Promise<void>
  onLatest(): void
}
type PendingPage = { scope: HistoryReadScope | undefined; generation: number }

/** Read-only durable window, independent from live replay and notification cursors. */
export function SessionHistoryView({ selection, request, readScope, navigation, onLatest, resultReader, onForkAt }: SessionHistoryViewProps) {
  const english = useLocale(state => state.locale) === "en"
  const c = (zh: string, en: string) => english ? en : zh
  const [state, setState] = useState<HistoryViewport>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<PendingPage>()
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState<string>()
  const generation = useRef(0)
  const pendingRead = useRef<PendingPage | undefined>(undefined)
  const scope = useRef(readScope)
  scope.current = readScope
  const busy = pending !== undefined && pending.scope === readScope && readScope?.isCurrent() !== false
  const validTarget = Number.isSafeInteger(selection.seq) && selection.seq >= 0
  const { workspaceId, sessionId, seq } = selection

  const readPage = useCallback(async (afterSeq: number, publish: (page: HistoryRange, current: () => boolean) => void) => {
    const owner = scope.current
    const active = pendingRead.current
    if (owner?.isCurrent() === false || active?.scope === owner && active?.generation === generation.current) return
    const ticket = { scope: owner, generation: generation.current }
    pendingRead.current = ticket
    setPending(ticket)
    setError(undefined)
    const current = () => generation.current === ticket.generation && scope.current === owner && owner?.isCurrent() !== false
    try {
      const page = await request({ kind: "session/history", workspaceId, sessionId, afterSeq, limit: HISTORY_PAGE_SIZE })
      if (pendingRead.current === ticket && current()) publish(page, current)
    } catch (error) {
      if (pendingRead.current === ticket && current()) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (pendingRead.current === ticket) {
        pendingRead.current = undefined
        if (current()) setPending(undefined)
      }
    }
  }, [request, workspaceId, sessionId])

  const loadTarget = useCallback(() => {
    if (!validTarget) { setError("搜尋位置無效"); return }
    const start = Math.max(0, seq - Math.floor(HISTORY_PAGE_SIZE / 2))
    void readPage(start, (page, current) => {
      const viewport = historyViewport(page, start)
      setState(previous => current() ? viewport : previous)
      if (!viewport.events.some(event => event.seq === seq)) setError("搜尋內容已變更，請重新搜尋")
    })
  }, [readPage, seq, validTarget])

  useEffect(() => {
    generation.current++
    pendingRead.current = undefined
    setState(undefined); setError(undefined); setPending(undefined)
    setForking(false); setForkError(undefined)
    loadTarget()
    return () => { generation.current++ }
  }, [loadTarget])
  useEffect(() => {
    // Keep settled search content readable after standby. Opening or paging
    // on the next transport requires another explicit user action.
    if (pendingRead.current?.scope !== readScope) pendingRead.current = undefined
    setPending(current => current?.scope === readScope ? current : undefined)
  }, [readScope])
  function page(direction: "before" | "after") {
    if (!state || busy) return
    const start = direction === "before" ? Math.max(0, state.startSeq - HISTORY_PAGE_SIZE) : state.endSeq
    void readPage(start, (result, current) => {
      setState(previous => previous && current() ? pageHistoryViewport(previous, result, start, direction) : previous)
    })
  }
  const hit = state?.events.find(event => event.seq === selection.seq)
  const forkPoint = hit?.historyTurn?.endSeq ?? (hit?.type === "turn/end" ? hit.seq : undefined)
  async function forkHere() {
    if (!onForkAt || forkPoint === undefined || forking) return
    const ticket = generation.current
    setForking(true); setForkError(undefined)
    try { await onForkAt({ ...selection, seq: forkPoint }) }
    catch (reason) { if (ticket === generation.current) setForkError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (ticket === generation.current) setForking(false) }
  }
  return <section className="session-history-view" aria-label={c("搜尋命中歷史", "Search result history")} style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
    <div className="provider-actions"><button disabled={busy || !state?.hasBefore} onClick={() => page("before")}>{c("載入較早內容", "Load earlier content")}</button><span title={String(selection.seq)}>{c("搜尋命中", "Search result")}</span><button disabled={busy || !state?.hasAfter} onClick={() => page("after")}>{c("載入較後內容", "Load later content")}</button>{!busy && !state && validTarget ? <button onClick={loadTarget}>{c("重試", "Retry")}</button> : null}<button onClick={onLatest}>{c("回到最新內容", "Return to latest content")}</button></div>
    {busy ? <p role="status">{c("正在載入歷史…", "Loading history…")}</p> : null}
    {onForkAt && forkPoint !== undefined ? <button type="button" className="link-button" disabled={forking || busy}
      onClick={() => { void forkHere() }}>{forking ? c("正在建立分支…", "Creating branch…") : c("從這個已完成回合建立分支", "Branch from this completed turn")}</button> : null}
    {forkError ? <p role="alert">{forkError}</p> : null}
    {error ? <p role="alert">{error === "搜尋位置無效" ? c(error, "Invalid search position") : error === "搜尋內容已變更，請重新搜尋" ? c(error, "Search content changed; search again") : error}</p> : null}
    {state ? <Timeline resultReader={resultReader?.workspaceId === selection.workspaceId && resultReader.sessionId === selection.sessionId ? resultReader : undefined} key={`${selection.workspaceId}:${selection.sessionId}:${selection.seq}`} rows={projectHistoryTimeline(state.events)} navigation={navigation} targetSeq={selection.seq} historical /> : null}
  </section>
}
