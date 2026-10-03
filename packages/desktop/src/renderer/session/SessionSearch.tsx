import { useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { SearchInput } from "../vendor/zcode/SearchInput.tsx"
import { useText } from "../design/i18n.ts"
interface Hit { sessionId: string; seq: number; snippet: string }
export interface HistorySelection { workspaceId: string; sessionId: string; seq: number }
export function SessionSearch({ bridge, workspaceId, sessionId, titles, onSelect }: {
  bridge: DesktopBridge; workspaceId: string; sessionId?: string;
  titles: Record<string, string>; onSelect(selection: HistorySelection): void
}) {
  const t = useText()
  const [query, setQuery] = useState("")
  const [currentOnly, setCurrentOnly] = useState(false)
  const [hits, setHits] = useState<Hit[]>()
  const [truncated, setTruncated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const requestId = useRef(0)
  useEffect(() => () => { requestId.current += 1 }, [])
  useEffect(() => { requestId.current += 1; setHits(undefined); setBusy(false); setError(undefined); setTruncated(false) }, [workspaceId, sessionId])
  function clear() { requestId.current += 1; setQuery(""); setHits(undefined); setBusy(false); setError(undefined); setTruncated(false) }
  async function search() {
    if (!query.trim()) return
    const id = ++requestId.current
    setBusy(true); setError(undefined); setHits(undefined); setTruncated(false)
    try {
      const result = await bridge.request({ kind: "desktop/session/search", workspaceId, query, limit: 50,
        ...(currentOnly && sessionId ? { sessionId } : {}),
      }) as { hits: Hit[]; truncated?: boolean }
      if (id !== requestId.current) return
      setHits(result.hits); setTruncated(result.truncated === true)
    } catch (reason) { if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (id === requestId.current) setBusy(false) }
  }
  return <section className="session-search" aria-label={t("搜尋會話")}>
    <h1>{t("搜尋會話")}</h1>
    <p className="muted">{t("搜尋此工作區已保存的會話內容，最多顯示 50 筆。")}</p>
    <form className="session-search-form" onSubmit={(event) => { event.preventDefault(); void search() }}>
      <SearchInput aria-label={t("搜尋會話內容")} placeholder={t("搜尋會話內容")} value={query} onChange={(event) => setQuery(event.target.value)} clearLabel={t("清除搜尋")} onClear={clear} />
      <button className="primary-button" disabled={!query.trim() || busy}>{t("搜尋")}</button>
    </form>
    {sessionId ? <label className="search-scope"><input type="checkbox" checked={currentOnly} onChange={(event) => { requestId.current += 1; setCurrentOnly(event.target.checked); setHits(undefined); setBusy(false) }} />{t("只搜尋目前會話")}</label> : null}
    {busy ? <p role="status">{t("正在搜尋…")}</p> : null}
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {truncated ? <p className="notice">{t("結果已截斷，請縮小搜尋範圍。")}</p> : null}
    {hits?.length === 0 ? <p className="muted">{t("沒有符合的會話內容")}</p> : null}
    <ul className="session-list search-results">{hits?.map((hit, index) => <li key={`${hit.sessionId}:${hit.seq}:${index}`}>
      <button className="row-button" onClick={() => onSelect({ workspaceId, sessionId: hit.sessionId, seq: hit.seq })}><span className="row-label">{titles[hit.sessionId] ?? t("未命名會話")}</span><span className="search-snippet">{hit.snippet}</span></button>
    </li>)}</ul>
  </section>
}
