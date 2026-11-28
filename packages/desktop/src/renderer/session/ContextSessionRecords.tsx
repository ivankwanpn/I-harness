import { useEffect, useMemo, useRef, useState } from "react"
import type { HistoryRange } from "@i-harness/sdk"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { CapturedValueBlock } from "./RawRecordedData.tsx"
import { InstructionsPane } from "./InstructionsPane.tsx"
import { loadEarlierHistory } from "./history.ts"
import { historyEvents, type WireEvent } from "./history-events.ts"

const PAGE_SIZE = 100
type RecordPage = { events: readonly WireEvent[]; startSeq: number; nextSeq: number; headSeq?: number }

/** An in-memory page is sufficient only when every requested position is present. */
function cachedPage(events: readonly WireEvent[], startSeq: number, nextSeq: number): RecordPage | undefined {
  let low = 0, high = events.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((events[middle]!.seq ?? -1) < startSeq) low = middle + 1
    else high = middle
  }
  const page = events.slice(low, low + nextSeq - startSeq)
  return page.length === nextSeq - startSeq && page.every((row, index) => row.seq === startSeq + index)
    ? { events: page, startSeq, nextSeq } : undefined
}
import { useToolText } from "./tool-text.ts"

/** The conversation already owns its latest public history window. Only an
 * explicit earlier-page action needs another read from the same session. */
export function ContextSessionRecords({ bridge, workspaceId, sessionId, recent, instructions }: {
  bridge: DesktopBridge; workspaceId: string; sessionId: string; recent: readonly WireEvent[]; instructions: boolean
}) {
  const t = useToolText()
  const [showSources, setShowSources] = useState(false)
  const [expanded, setExpanded] = useState<number>()
  const [older, setOlder] = useState<RecordPage>()
  const flight = useRef<object | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => () => { flight.current = undefined }, [])
  const lastRows = recent.slice(-PAGE_SIZE)
  // If a live notification jumped past the cached prefix, an earlier page
  // must start at the gap; displaying both sides would skip that interval.
  const lastGap = lastRows.findLastIndex((row, i) => i > 0 && row.seq !== (lastRows[i - 1]!.seq ?? -1) + 1)
  const tail = lastGap < 0 ? lastRows : lastRows.slice(lastGap)
  const tailStart = tail[0]?.seq ?? 0
  const tailEnd = tail.length ? (tail.at(-1)!.seq ?? tailStart) + 1 : 0
  const events = older?.events ?? tail
  const start = older?.startSeq ?? tailStart
  const head = Math.max(tailEnd, older?.headSeq ?? 0)
  const records = events.filter(event => event.seq !== undefined && (event.type === "user/message" && !event.internal
    || event.type === "assistant/message" || event.type === "tool/call" || event.type === "tool/result"))
  async function move(direction: "before" | "after") {
    if (flight.current) return
    const first = direction === "before" ? Math.max(0, start - PAGE_SIZE) : older?.nextSeq
    if (first === undefined) return
    const end = direction === "before" ? start : Math.min(head, first + PAGE_SIZE)
    if (first >= end) return
    const ticket = {}
    flight.current = ticket
    setBusy(true); setError(undefined)
    try {
      let page = cachedPage(recent, first, end)
      if (!page) {
        const request = (params: { afterSeq: number; beforeSeq?: number; limit: number }) =>
          bridge.request({ kind: "session/history", workspaceId, sessionId, ...params }) as Promise<HistoryRange>
        const range = direction === "before" ? await loadEarlierHistory(request, start, PAGE_SIZE)
          : await request({ afterSeq: first, limit: end - first })
        const rangeStart = range.startSeq ?? range.nextSeq - range.events.length
        const startSeq = Math.max(first, rangeStart), nextSeq = Math.min(end, range.nextSeq)
        if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(nextSeq) || startSeq >= nextSeq) {
          throw Error(t("無法讀取這一頁記錄。", "This history page is unavailable."))
        }
        page = { startSeq, nextSeq, headSeq: range.headSeq,
          events: historyEvents(range, first).filter(row => row.seq !== undefined && row.seq >= startSeq && row.seq < nextSeq) }
      }
      if (flight.current !== ticket) return
      setExpanded(undefined)
      setOlder(page)
    } catch (cause) { if (flight.current === ticket) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (flight.current === ticket) { flight.current = undefined; setBusy(false) } }
  }
  return <>
    {instructions ? <details className="context-source-disclosure" onToggle={event => setShowSources(event.currentTarget.open)}>
      <summary>{t("指令來源", "Instruction sources")}</summary>
      {showSources ? <InstructionsPane bridge={bridge} workspaceId={workspaceId} sessionId={sessionId} /> : null}
    </details> : null}
    <section className="context-record-list" aria-label={t("原始訊息", "Raw messages")}>
      <h2>{t("原始訊息", "Raw messages")}</h2>
      {!records.length ? <p>{t("這一段歷史沒有訊息或工具記錄。", "This history window contains no messages or tool records.")}</p> : null}
      {records.map(record => {
        const seq = record.seq!
        const role = record.type.split("/")[0]
        return <details key={seq} open={expanded === seq}>
          <summary onClick={event => { event.preventDefault(); setExpanded(expanded === seq ? undefined : seq) }}>
            <span>{role === "tool" ? record.type : role}</span><code>#{seq}</code>
          </summary>
          {expanded === seq ? <MessageBody record={record} /> : null}
        </details>
      })}
      {error ? <p role="alert">{error}</p> : null}
      {start > 0 || older ? <div className="context-record-navigation">
        {start > 0 ? <Button size="small" variant="ghost" disabled={busy} onClick={() => void move("before")}>{t("較早記錄", "Earlier records")}</Button> : null}
        {older && older.nextSeq < head ? <Button size="small" variant="ghost" disabled={busy} onClick={() => void move("after")}>{t("較新記錄", "Newer records")}</Button> : null}
        {older ? <Button size="small" variant="ghost" onClick={() => { flight.current = undefined; setBusy(false); setOlder(undefined); setExpanded(undefined); setError(undefined) }}>{t("返回最新記錄", "Latest records")}</Button> : null}
      </div> : null}
    </section>
  </>
}

function MessageBody({ record }: { record: WireEvent }) {
  const t = useToolText()
  const raw = useMemo(() => {
    const { historyTurn: _page, historySourceSeq, ...fields } = record
    if (historySourceSeq === undefined) return fields
    const { seq: _position, ...source } = fields
    return historySourceSeq === null ? source : { ...source, seq: historySourceSeq }
  }, [record])
  return <CapturedValueBlock label={t("原始記錄", "Raw record")} value={raw} />
}
