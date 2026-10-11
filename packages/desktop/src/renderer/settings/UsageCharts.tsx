import { useEffect, useState } from "react"
import type { UsageQuery, UsageSnapshot, UsageTotals } from "@i-harness/usage-stats"
import { usageCalendar, usageTokenSegments, usageTrendRuns, type UsageText } from "./usage-statistics-helpers.ts"

type Metric = "tokens" | "requests" | "cost"
export function UsageCharts({ snapshot, range, t, number, money }: { snapshot: UsageSnapshot; range: UsageQuery; t: UsageText; number(value: number | null | undefined): string; money(value: number | null | undefined): string }) {
  const [chartStyle, setChartStyle] = useState<"bars" | "line" | "area">("bars")
  const [metric, setMetric] = useState<Metric>("tokens")
  const [hovered, setHovered] = useState<string>()
  const dates = usageCalendar(range.start, range.end)
  const inspectedDate = hovered && dates.includes(hovered) ? hovered : undefined
  useEffect(() => { if (hovered && !inspectedDate) setHovered(undefined) }, [hovered, inspectedDate])
  const daily = new Map(snapshot.daily.map(day => [day.date, day]))
  const segments = (day: UsageTotals | undefined): Array<number | null> => !day ? [0] : metric === "tokens" ? usageTokenSegments(day) : metric === "requests" ? [day.completed, day.failed, day.cancelled] : [day.estimatedCostUsd]
  const measuredMax = Math.max(0, ...snapshot.daily.map(day => segments(day).reduce<number>((sum, value) => sum + (value ?? 0), 0)))
  const max = measuredMax > 0 ? measuredMax : 1
  const chartWidth = 880, chartHeight = 210, left = 56, bottom = 27, top = 14
  const plotHeight = chartHeight - bottom - top, plotWidth = chartWidth - left - 10
  const step = plotWidth / Math.max(dates.length, 1)
  const value = (day: UsageTotals | undefined) => !day ? 0 : metric === "tokens" ? day.totalTokens : metric === "requests" ? day.requests : day.estimatedCostUsd
  const format = (value: number | null | undefined) => metric === "cost" ? money(value) : number(value)
  const legend = chartStyle !== "bars" ? [metric === "tokens" ? t("Token 總量", "Total tokens") : metric === "requests" ? t("請求次數", "Requests") : t("預估 API 費用", "Estimated API cost")] : metric === "tokens" ? [t("未快取輸入", "Uncached input"), t("快取讀取", "Cache read"), t("快取寫入", "Cache write"), t("輸出", "Output"), t("未分類 Token", "Unclassified tokens")] : metric === "requests" ? [t("完成", "Completed"), t("失敗", "Failed"), t("取消", "Cancelled")] : [t("預估 API 費用", "Estimated API cost")]
  const trendRuns = usageTrendRuns(dates.map(date => value(daily.get(date))))
  const point = (index: number, measured: number) => ({ x: left + step * (index + .5), y: top + plotHeight - measured / max * plotHeight })
  const selected = inspectedDate ? daily.get(inspectedDate) : undefined
  const maxRequests = Math.max(1, ...snapshot.daily.map(day => day.requests))
  const ranked = [...snapshot.models].sort((a, b) => (b.totalTokens ?? -1) - (a.totalTokens ?? -1)).slice(0, 5)
  const topTokens = Math.max(1, ...ranked.map(model => model.totalTokens ?? 0))
  return <>
    <section className="usage-panel usage-trend"><div className="usage-panel-header"><div><h2>{t("每日趨勢", "Daily trend")}</h2><p>{t("所選期間的已記錄用量", "Recorded usage over the selected period")}</p></div><div className="usage-presets usage-metrics" aria-label={t("趨勢指標", "Trend metric")}>{([["tokens", "Tokens"], ["requests", t("請求", "Requests")], ["cost", t("費用", "Cost")]] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={metric === key} onClick={() => setMetric(key)}>{label}</button>)}</div></div>
      <div className="usage-chart-style-row"><span>{chartStyle === "bars" ? t("分項堆疊", "Component breakdown") : t("每日總量", "Daily total")}</span><div className="usage-presets usage-chart-styles" aria-label={t("圖表樣式", "Chart style")}>{([["bars", t("柱狀", "Bars")], ["line", t("折線", "Line")], ["area", t("面積", "Area")]] as const).map(([style, label]) => <button type="button" key={style} aria-pressed={chartStyle === style} onClick={() => setChartStyle(style)}>{label}</button>)}</div></div>
      <div className="usage-chart-scroll"><svg className="usage-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={t("每日用量圖表；下方可選取日期查看數值。", "Daily usage chart; select a date below to inspect values.")}>
        {[0, .5, 1].map(fraction => <g key={fraction}><line x1={left} x2={chartWidth - 10} y1={top + plotHeight * (1 - fraction)} y2={top + plotHeight * (1 - fraction)} className="usage-chart-grid" /><text x={left - 9} y={top + plotHeight * (1 - fraction) + 4} textAnchor="end">{metric === "cost" ? money(max * fraction) : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(max * fraction)}</text></g>)}
        {dates.map((date, index) => { let offset = 0; const values = segments(daily.get(date)); return <g key={date} onMouseEnter={() => setHovered(date)}>{chartStyle === "bars" && values.map((segment, part) => { if (segment === null) return null; const height = segment / max * plotHeight; offset += height; return <rect key={part} x={left + step * index + step * .15} y={top + plotHeight - offset} width={Math.max(.5, step * .7)} height={height} className={`usage-fill-${part}`}><title>{`${date} · ${legend[part] ?? legend[0]}: ${format(segment)}`}</title></rect> })}{(index === 0 || index === dates.length - 1 || (dates.length > 8 && index % Math.ceil(dates.length / 6) === 0 && index < dates.length - 2)) && <text x={left + step * (index + .5)} y={chartHeight - 5} textAnchor="middle">{date.slice(5)}</text>}</g> })}
        {chartStyle !== "bars" && trendRuns.map((run, runIndex) => {
          const points = run.map(sample => point(sample.index, sample.value))
          const path = points.map((p, index) => `${index === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ")
          const first = points[0]!, last = points[points.length - 1]!
          return <g key={runIndex}>
            {chartStyle === "area" && <path className="usage-trend-area" d={`${path} L${last.x},${top + plotHeight} L${first.x},${top + plotHeight} Z`} />}
            <path className="usage-trend-line" d={path} />
            {run.map(sample => { const p = point(sample.index, sample.value); return <circle key={sample.index} cx={p.x} cy={p.y} r={dates.length < 60 ? 2.5 : 1.5} className="usage-trend-point" onMouseEnter={() => setHovered(dates[sample.index])}><title>{`${dates[sample.index]}: ${format(sample.value)}`}</title></circle> })}
          </g>
        })}
      </svg></div>
      <div className="usage-chart-footer"><div className="usage-legend">{legend.map((label, index) => <span key={label}><i className={`usage-dot usage-color-${index}`} />{label}</span>)}</div><label className="usage-chart-inspect">{t("查看日期", "Inspect date")}<select aria-label={t("查看趨勢日期", "Inspect trend date")} value={inspectedDate ?? ""} onChange={event => setHovered(event.target.value || undefined)}><option value="">{t("選擇日期", "Select date")}</option>{dates.map(date => <option key={date} value={date}>{date}</option>)}</select></label></div>
      {inspectedDate ? <p className="usage-chart-value" role="status"><strong>{inspectedDate}</strong> · {format(value(selected))}{selected && <> · {t(`${selected.measuredRequests}/${selected.requests} 筆有 Token 測量`, `${selected.measuredRequests}/${selected.requests} with token measurements`)}</>}{segments(selected).some(segment => segment === null) && <> · {t("部分測量未提供", "Some measurements unavailable")}</>}</p> : <p className="usage-chart-value">{t("Token 圖表只包含總量完整的請求；灰色柱段為已知總量但未提供分類的 Token。", "Token charts include only requests with complete totals. Gray bars show known tokens with an unavailable breakdown.")}</p>}
    </section>
    <div className="usage-secondary-grid"><section className="usage-panel usage-activity"><div className="usage-panel-header"><div><h2>{t("請求活動", "Request activity")}</h2><p>{t(`${dates.length} 天 · 每格一天`, `${dates.length} days · one cell per day`)}</p></div><span className="usage-total-badge">{number(snapshot.summary.requests)}</span></div><div className="usage-heatmap" aria-label={t("每日請求活動", "Daily request activity")}>{dates.map(date => { const count = daily.get(date)?.requests ?? 0; return <button key={date} type="button" className={`usage-heat-${count === 0 ? 0 : Math.max(1, Math.ceil(count / maxRequests * 4))}`} aria-label={`${date}: ${count} ${t("筆請求", "requests")}`} title={`${date}: ${count} ${t("筆請求", "requests")}`} onFocus={() => setHovered(date)} onClick={() => setHovered(date)} /> })}</div><div className="usage-heat-legend"><span>{dates[0]}</span><div>{t("少", "Less")}{[0, 1, 2, 3, 4].map(level => <i key={level} className={`usage-heat-${level}`} />)}{t("多", "More")}</div><span>{dates.at(-1)}</span></div></section>
      <section className="usage-panel usage-ranking"><div className="usage-panel-header"><div><h2>{t("常用模型", "Top models")}</h2><p>{t("按已測量 Token 排名", "Ranked by measured tokens")}</p></div><span className="usage-total-badge">{snapshot.models.length}</span></div><div className="usage-rank-list">{ranked.length ? ranked.map((model, index) => <div key={model.key}><div><span className="usage-rank-index">{String(index + 1).padStart(2, "0")}</span><strong title={model.label}>{model.label}</strong><span>{number(model.totalTokens)}</span></div><div className="usage-rank-track"><i style={{ width: `${(model.totalTokens ?? 0) / topTokens * 100}%` }} /></div></div>) : <p className="usage-muted">{t("尚無模型用量", "No model usage yet")}</p>}</div></section></div>
  </>
}
