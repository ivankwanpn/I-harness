import { useEffect, useMemo, useRef, useState } from "react"
import type { HistoryRange } from "@i-harness/sdk"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { CapturedValueBlock } from "./RawRecordedData.tsx"
import { InstructionsPane } from "./InstructionsPane.tsx"
import { loadEarlierHistory } from "./history.ts"
import type { WireEvent } from "./history-events.ts"
import { useToolText } from "./tool-text.ts"

/** The conversation already owns its latest public history window. Only an
 * explicit earlier-page action needs another read from the same session. */
export function ContextSessionRecords({ bridge, workspaceId, sessionId, recent, instructions }: {
  bridge: DesktopBridge; workspaceId: string; sessionId: string; recent: readonly WireEvent[]; instructions: boolean
}) {
  const t = useToolText()
  const [showSources, setShowSources] = useState(false)
  const [expanded, setExpanded] = useState<number>()
  const [older, setOlder] = useState<HistoryRange>()
  const flight = useRef<object | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => () => { flight.current = undefined }, [])
  const events = older?.events ?? recent
  const start = older?.startSeq ?? events.find(event => event.seq !== undefined)?.seq ?? 0
  const records = events.filter(event => event.seq !== undefined && (event.type === "user/message" && !event.internal
    || event.type === "assistant/message" || event.type === "tool/call" || event.type === "tool/result"))
  async function earlier() {
    if (start <= 0 || flight.current) return
    const ticket = {}
    flight.current = ticket
    setBusy(true); setError(undefined)
    try {
      const page = await loadEarlierHistory(params => bridge.request({ kind: "session/history", workspaceId, sessionId, ...params }) as Promise<HistoryRange>, start, 100)
      if (flight.current !== ticket) return
      if (page.events.length && (page.startSeq ?? page.events[0]?.seq ?? start) >= start) throw Error(t("無法讀取較早記錄。", "Earlier records are unavailable."))
      setExpanded(undefined)
      setOlder({ ...page, events: page.events.filter(row => row.seq !== undefined && row.seq < start) })
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
        {start > 0 ? <Button size="small" variant="ghost" disabled={busy} onClick={() => void earlier()}>{t("較早記錄", "Earlier records")}</Button> : null}
        {older ? <Button size="small" variant="ghost" onClick={() => { flight.current = undefined; setBusy(false); setOlder(undefined); setExpanded(undefined); setError(undefined) }}>{t("返回最新記錄", "Latest records")}</Button> : null}
      </div> : null}
    </section>
  </>
}

function MessageBody({ record }: { record: WireEvent }) {
  const t = useToolText()
  const raw = useMemo(() => {
    const { historyTurn: _page, ...fields } = record
    return fields
  }, [record])
  return <CapturedValueBlock label={t("原始記錄", "Raw record")} value={raw} />
}
