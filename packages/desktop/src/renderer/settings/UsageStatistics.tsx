import { useEffect, useMemo, useState, type KeyboardEvent } from "react"
import { Activity, ArrowDownUp, Coins, Database, RefreshCw, SlidersHorizontal, Zap } from "lucide-react"
import type { UsageDetail, UsageGroup, UsagePrice, UsageQuery, UsageSnapshot } from "@i-harness/usage-stats"
import { useLocale } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { SettingsDialog } from "./SettingsDialog.tsx"
import { UsageCharts } from "./UsageCharts.tsx"
import { UsagePricing } from "./UsagePricing.tsx"
import { localDate, usageDateRange, type UsageRange } from "./usage-statistics-helpers.ts"
import "./UsageStatistics.css"

export type UsageStatisticsRequest = { kind: "desktop/usage/query"; query: UsageQuery } | { kind: "desktop/usage/pricing"; price: UsagePrice }
export interface UsageStatisticsProps { active: boolean; projectLabels?: Record<string, string>; workspaceLabels?: Record<string, string>; request(request: UsageStatisticsRequest): Promise<unknown> }

export function UsageStatistics({ active, request, projectLabels = {}, workspaceLabels = {} }: UsageStatisticsProps) {
  const locale = useLocale(state => state.locale)
  const t = (zh: string, en: string) => locale === "en" ? en : zh
  const [preset, setPreset] = useState<UsageRange>("30")
  const [start, setStart] = useState(() => localDate(new Date()))
  const [end, setEnd] = useState(() => localDate(new Date()))
  const [workspace, setWorkspace] = useState("")
  const [projectId, setProject] = useState("")
  const [providerId, setProvider] = useState("")
  const [modelId, setModel] = useState("")
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<UsageQuery["sort"]>("newest")
  const [tab, setTab] = useState<"models" | "providers" | "requests">("models")
  const [groupSort, setGroupSort] = useState<"requests" | "totalTokens" | "estimatedCostUsd">("totalTokens")
  const [groupPage, setGroupPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<UsageSnapshot>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<UsageDetail>()
  const [pricing, setPricing] = useState(false)
  const range = useMemo(() => usageDateRange(preset, start, end), [preset, start, end, revision, active])
  const query = useMemo<UsageQuery | null>(() => range ? { ...range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, workspace: workspace || undefined, projectId: projectId || undefined, providerId: providerId || undefined, modelId: modelId || undefined, page, pageSize: 25, sort } : null, [range, workspace, projectId, providerId, modelId, page, sort])
  const [loadedQuery, setLoadedQuery] = useState<UsageQuery | null>(null)
  useEffect(() => {
    if (!active || !query) { setLoading(false); return }
    let stale = false
    setLoading(true)
    setError(undefined)
    Promise.resolve().then(() => request({ kind: "desktop/usage/query", query })).then(value => {
      if (stale) return
      setSnapshot(value as UsageSnapshot)
      setLoadedQuery(query)
    }).catch(reason => { if (!stale) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [active, query, request, revision])
  const number = (value: number | null | undefined) => value == null ? t("未提供", "Unavailable") : value.toLocaleString(locale, { maximumFractionDigits: 0 })
  const money = (value: number | null | undefined) => value == null ? t("未提供", "Unavailable") : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value)
  const percent = (value: number | null) => value === null ? t("未提供", "Unavailable") : `${(value * 100).toFixed(1)}%`
  const changeScope = (change: () => void) => { change(); setPage(1); setGroupPage(1); setDetail(undefined) }
  const changeTabWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, current: typeof tab) => {
    const tabs = ["models", "providers", "requests"] as const
    const index = tabs.indexOf(current)
    const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : undefined
    if (!next) return
    event.preventDefault(); setTab(next); setGroupPage(1)
    document.getElementById(`usage-tab-${next}`)?.focus()
  }
  const summary = snapshot?.summary
  const currentData = snapshot && loadedQuery === query
  const groups: UsageGroup[] = [...(tab === "providers" ? snapshot?.providers ?? [] : snapshot?.models ?? [])].sort((a, b) => (b[groupSort] ?? -1) - (a[groupSort] ?? -1))
  const pageCount = Math.max(1, Math.ceil((tab === "requests" ? snapshot?.totalRecords ?? 0 : groups.length) / 25))
  const currentPage = tab === "requests" ? page : groupPage
  const billing = (record: UsageDetail) => record.billing === "subscription" ? t("訂閱 · 不估算 API 費用", "Subscription · no API cost estimate") : record.estimatedCostUsd === null ? record.price ? t("估算不可用", "Estimate unavailable") : t("未定價", "Unpriced") : money(record.estimatedCostUsd)
  const status = (value: UsageDetail["status"]) => ({ completed: t("已完成", "Completed"), failed: t("失敗", "Failed"), cancelled: t("已取消", "Cancelled") })[value]

  return <section className="usage-statistics" aria-label={t("用量統計", "Usage statistics")} aria-busy={loading}>
    <div className="usage-toolbar">
      <div className="usage-presets" aria-label={t("日期範圍", "Date range")}>{([["today", t("今天", "Today")], ["7", t("7 天", "7 days")], ["30", t("30 天", "30 days")], ["custom", t("自訂", "Custom")]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={preset === value} onClick={() => changeScope(() => setPreset(value))}>{label}</button>)}</div>
      <div className="usage-actions"><Button variant="ghost" size="small" icon={<SlidersHorizontal size={15} />} onClick={() => setPricing(true)}>{t("API 定價", "API pricing")}</Button><Button variant="secondary" size="small" icon={<RefreshCw size={14} className={loading ? "usage-spinning" : ""} />} disabled={loading || !query} onClick={() => setRevision(value => value + 1)}>{t("重新整理", "Refresh")}</Button></div>
    </div>
    {preset === "custom" && <div className="usage-custom"><label>{t("開始日期", "Start date")}<input type="date" value={start} onChange={event => changeScope(() => setStart(event.target.value))} /></label><span>—</span><label>{t("結束日期", "End date")}<input type="date" value={end} onChange={event => changeScope(() => setEnd(event.target.value))} /></label></div>}
    {!range && <p role="alert">{t("請選擇有效的日期範圍（最多 366 天）。", "Choose a valid date range (up to 366 days).")}</p>}
    <div className="usage-filters">{[{ label: t("工作區", "Workspace"), value: workspace, options: snapshot?.options.workspaces ?? [], set: setWorkspace, labels: workspaceLabels }, { label: t("專案", "Project"), value: projectId, options: snapshot?.options.projects ?? [], set: setProject, labels: projectLabels }, { label: t("提供商", "Provider"), value: providerId, options: snapshot?.options.providers ?? [], set: setProvider }, { label: t("模型", "Model"), value: modelId, options: snapshot?.options.models ?? [], set: setModel }].map(filter => <label key={filter.label}><span>{filter.label}</span><select value={filter.value} onChange={event => changeScope(() => filter.set(event.target.value))}><option value="">{t("全部", "All")}</option>{filter.options.map(option => <option value={option} key={option}>{filter.labels?.[option] ?? option}</option>)}</select></label>)}<span className="usage-zone">{query?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}<br />{t("本機日曆日期", "Local calendar dates")}</span></div>
    {error && <div role="alert" className="usage-notice">{t("無法更新用量。", "Could not refresh usage.")} {error}{snapshot && <p>{t("下方保留上次成功載入的資料。", "Showing the last successfully loaded data below.")}</p>}</div>}
    {snapshot?.warnings.length ? <div role="status" className="usage-notice">{t("統計可能不完整。請檢視下方記錄警告。", "Statistics may be incomplete. Review the recording warnings below.")}<ul>{snapshot.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}
    {!snapshot ? <div className="usage-empty" role="status"><Activity size={30} /><p>{loading ? t("正在讀取用量記錄…", "Loading usage records…") : t("尚未載入用量。", "Usage has not loaded yet.")}</p></div> : <>
      {!currentData && !error && <p role="status" className="usage-muted">{loading ? t("正在更新；下方為上次載入的資料。", "Updating; the previous results are shown below.") : t("下方為上次載入的資料。", "The previous results are shown below.")}</p>}
      <div className="usage-summary">
        <article data-testid="usage-requests"><div className="usage-card-label"><Activity size={16} />{t("請求次數", "Requests")}</div><strong>{number(summary!.requests)}</strong><p>{number(summary!.completed)} {t("完成", "completed")} · {number(summary!.failed)} {t("失敗", "failed")}</p></article>
        <article><div className="usage-card-label"><Zap size={16} />{t("Token 總量", "Total tokens")}</div><strong>{number(summary!.totalTokens)}</strong><p>{t(`${summary!.measuredRequests} / ${summary!.requests} 筆請求已測量`, `${summary!.measuredRequests} / ${summary!.requests} requests measured`)}</p></article>
        <article><div className="usage-card-label"><Database size={16} />{t("快取命中率", "Cache hit rate")}</div><strong>{percent(summary!.cacheHitRate)}</strong><p>{t(`Token 加權 · ${summary!.cacheMeasuredRequests} 筆可測量請求`, `Token weighted · ${summary!.cacheMeasuredRequests} measured requests`)}</p></article>
        <article data-testid="usage-cost"><div className="usage-card-label"><Coins size={16} />{t("預估 API 費用", "Estimated API cost")}</div><strong>{money(summary!.estimatedCostUsd)}</strong><p>{t(`${summary!.pricedRequests} 筆已定價 · ${summary!.subscriptionRequests} 筆訂閱`, `${summary!.pricedRequests} priced · ${summary!.subscriptionRequests} subscription`)}</p></article>
      </div>
      <div className="usage-breakdown">{[[t("未快取輸入", "Uncached input"), summary!.uncachedInputTokens], [t("快取讀取", "Cache read"), summary!.cacheReadTokens], [t("快取寫入", "Cache write"), summary!.cacheCreationTokens], [t("輸出", "Output"), summary!.outputTokens]].map(([label, value], index) => <div key={label as string}><i className={`usage-dot usage-color-${index}`} /><span>{label}</span><strong>{number(value as number | null)}</strong></div>)}</div>
      {summary!.requests === 0 ? <div className="usage-empty"><Activity size={30} /><h2>{t("此範圍沒有請求", "No requests in this range")}</h2><p>{t("新的模型請求會自動記錄於此。請嘗試其他日期或篩選條件。", "New model requests are recorded here automatically. Try another date range or filter.")}</p></div> : null}
      <UsageCharts snapshot={snapshot} range={loadedQuery!} t={t} number={number} money={money} />
      <section className="usage-panel usage-records"><div className="usage-panel-header"><div className="usage-tabs" role="tablist" aria-label={t("用量明細", "Usage breakdown")}>{([["models", t("模型", "Models")], ["providers", t("提供商", "Providers")], ["requests", t("請求", "Requests")]] as const).map(([value, label]) => <button type="button" role="tab" id={`usage-tab-${value}`} tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} onKeyDown={event => changeTabWithKeyboard(event, value)} aria-controls="usage-table" key={value} onClick={() => { setTab(value); setGroupPage(1) }}>{label}</button>)}</div><label className="usage-sort"><ArrowDownUp size={14} /><select aria-label={t("排序", "Sort")} value={tab === "requests" ? sort : groupSort} onChange={event => { if (tab === "requests") changeScope(() => setSort(event.target.value as UsageQuery["sort"])); else { setGroupSort(event.target.value as typeof groupSort); setGroupPage(1) } }}>{tab === "requests" ? <><option value="newest">{t("最新優先", "Newest first")}</option><option value="oldest">{t("最舊優先", "Oldest first")}</option><option value="tokens">{t("Token 最多", "Most tokens")}</option></> : <><option value="totalTokens">{t("Token 最多", "Most tokens")}</option><option value="requests">{t("請求最多", "Most requests")}</option><option value="estimatedCostUsd">{t("費用最高", "Highest cost")}</option></>}</select></label></div>
        <div className="usage-table-scroll" id="usage-table" role="tabpanel" aria-labelledby={`usage-tab-${tab}`}><table><thead><tr>{(tab === "requests" ? [t("時間 / 模型", "Time / model"), t("提供商", "Provider"), t("狀態", "Status"), "Tokens", t("費用", "Cost"), ""] : [tab === "models" ? t("模型", "Model") : t("提供商", "Provider"), t("請求", "Requests"), "Tokens", t("快取命中率", "Cache hit"), t("預估費用", "Estimated cost")]).map((heading, index) => <th key={index}>{heading}</th>)}</tr></thead><tbody>{tab === "requests" ? snapshot.records.map(record => <tr key={record.id}><td><strong>{record.modelId}</strong><small>{new Date(record.startedAt).toLocaleString(locale)}</small></td><td>{record.providerId}</td><td><span className={`usage-status usage-status-${record.status}`}>{status(record.status)}</span></td><td>{number(record.totalTokens)}</td><td>{record.billing === "subscription" ? t("訂閱", "Subscription") : record.estimatedCostUsd === null ? record.price ? t("估算不可用", "Estimate unavailable") : t("未定價", "Unpriced") : money(record.estimatedCostUsd)}</td><td><Button variant="ghost" size="small" aria-label={t(`檢視請求 ${record.id}`, `View request ${record.id}`)} onClick={() => setDetail(record)}>{t("詳情", "Details")}</Button></td></tr>) : groups.slice((groupPage - 1) * 25, groupPage * 25).map(group => <tr key={group.key}><td><strong>{group.label}</strong></td><td>{number(group.requests)}</td><td>{number(group.totalTokens)}</td><td>{percent(group.cacheHitRate)}</td><td>{money(group.estimatedCostUsd)}</td></tr>)}</tbody></table>{(tab === "requests" ? snapshot.records.length : groups.length) === 0 && <p className="usage-table-empty">{t("沒有記錄", "No records")}</p>}</div>
        <footer className="usage-pagination"><span>{t(`第 ${currentPage} / ${pageCount} 頁`, `Page ${currentPage} of ${pageCount}`)}</span><div><Button variant="ghost" size="small" disabled={currentPage <= 1 || loading} onClick={() => tab === "requests" ? setPage(value => value - 1) : setGroupPage(value => value - 1)}>{t("上一頁", "Previous page")}</Button><Button variant="ghost" size="small" disabled={currentPage >= pageCount || loading} onClick={() => tab === "requests" ? setPage(value => value + 1) : setGroupPage(value => value + 1)}>{t("下一頁", "Next page")}</Button></div></footer>
      </section>
      <p className="usage-footnote">{t("本機記錄；未提供的測量值不會當作零。費用是依明確設定的單價估算，並非帳單；訂閱 Token 不代表剩餘額度。", "Local records. Missing measurements are never treated as zero. Costs use explicit prices and are estimates, not bills. Subscription tokens do not represent remaining allowance.")}<br />{snapshot.recordingSince && <>{t("開始記錄：", "Recording since: ")}{new Date(snapshot.recordingSince).toLocaleDateString(locale)} · </>}{t("更新：", "Updated: ")}{new Date(snapshot.generatedAt).toLocaleString(locale)}</p>
    </>}
    {detail && <SettingsDialog title={t("請求詳情", "Request details")} closeLabel={t("關閉", "Close")} active={active} initialFocusSelector="button" onClose={() => setDetail(undefined)}><p className="usage-detail-billing">{billing(detail)}</p><dl className="usage-detail">{[[t("請求 ID", "Request ID"), detail.id], [t("模型", "Model"), detail.modelId], [t("提供商", "Provider"), detail.providerId], [t("工作區", "Workspace"), workspaceLabels[detail.workspace] ?? detail.workspace], [t("專案", "Project"), detail.projectId ? projectLabels[detail.projectId] ?? detail.projectId : "—"], [t("會話", "Session"), detail.sessionId ?? "—"], [t("時間", "Time"), new Date(detail.startedAt).toLocaleString(locale)], [t("狀態", "Status"), status(detail.status)], [t("耗時", "Duration"), `${(detail.durationMs / 1000).toFixed(2)} s`], [t("首個 Token", "First token"), detail.firstTokenMs == null ? "—" : `${detail.firstTokenMs} ms`], [t("總輸入", "Total input"), number(detail.totalInputTokens)], [t("未快取輸入", "Uncached input"), number(detail.uncachedInputTokens)], [t("快取讀取", "Cache read"), number(detail.cacheReadTokens)], [t("快取寫入", "Cache write"), number(detail.cacheCreationTokens)], [t("輸出", "Output"), number(detail.outputTokens)], ["Tokens", number(detail.totalTokens)], [t("輸入語意", "Input semantics"), detail.inputTokenSemantics === "includes-cache" ? t("包含快取", "Includes cache") : detail.inputTokenSemantics === "excludes-cache" ? t("不含快取", "Excludes cache") : "—"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{detail.price && <p className="usage-footnote">{t("定價來源：", "Price source: ")}{detail.price.source}<br />{new Date(detail.price.updatedAt).toLocaleString(locale)}</p>}</SettingsDialog>}
    {pricing && <UsagePricing active={active} request={request} prices={snapshot?.prices ?? []} providers={snapshot?.options.providers ?? []} models={snapshot?.options.models ?? []} t={t} onClose={() => setPricing(false)} onSaved={() => { setPricing(false); setRevision(value => value + 1) }} />}
  </section>
}
