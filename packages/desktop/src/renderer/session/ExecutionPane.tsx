import { useEffect, useState } from "react"
import type { DesktopExecutionView, ExecutionRequest } from "@i-harness/desktop-gateway/src/execution.ts"
import { useExecutionSurface } from "./execution-surface.ts"
import { useExecutionText } from "./execution-i18n.ts"

export function ExecutionPane({ bridge, workspaceId, sessionId }: { bridge: { request(request: ExecutionRequest): Promise<unknown> }; workspaceId: string; sessionId: string }) {
  const t = useExecutionText()
  const [offset, setOffset] = useState(0)
  const [tab, setTab] = useState<"code" | "output" | "trace">("code")
  const [stop, setStop] = useState<string>()
  const scope = `${workspaceId}:${sessionId}`
  const view = useExecutionSurface<DesktopExecutionView>(() => bridge.request({ kind: "desktop/session/execution/read", workspaceId, sessionId, offset, limit: 10 }), `${scope}:${offset}`, true)
  useEffect(() => { setOffset(0); setStop(undefined) }, [scope])
  return <section className="workflow-section" aria-label={t("執行檢視")}>
    <div className="workflow-heading"><h2>{t("執行檢視")}</h2><button disabled={view.busy} onClick={() => { void view.refresh() }}>{t("重新整理")}</button></div>
    <p className="workflow-meta">{view.state?.effectiveMode ? `${t("目前有效模式")}：${view.state.effectiveMode}` : t("已儲存執行記錄")}</p>
    <div role="tablist" aria-label={t("Cell 內容")}>
      {([["code", "程式"], ["output", "輸出"], ["trace", "巢狀呼叫"]] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{t(label)}</button>)}
    </div>
    {view.error ? <p role="alert" className="error-text">{view.error}</p> : null}
    {!view.state && !view.error ? <p role="status">{t("正在讀取…")}</p> : null}
    {view.state?.cells.length === 0 ? <p>{t("尚無 Code Mode cell")}</p> : null}
    <div role="tabpanel">{view.state?.cells.map(cell => <article key={cell.id} className="workflow-card">
      <div className="workflow-heading"><h3><code>{cell.id}</code></h3><span>{cell.status} · {cell.live ? t("活躍") : t("歷史")}</span></div>
      <p className="workflow-meta">owner: <code>{cell.ownerSessionId}</code>{cell.parentCallId ? ` · parent: ${cell.parentCallId}` : ""}</p>
      {tab === "code" ? <pre>{cell.source || t("此記錄未保存程式")}</pre> : tab === "output" ? <div>{cell.output.length ? cell.output.map((item, index) => <pre key={index}>{item.kind === "text" ? item.text : `${item.kind}: ${item.text}`}</pre>) : <p>{t("此 cell 尚無輸出")}</p>}</div>
        : <div>{cell.calls.length ? cell.calls.map(call => <details key={call.id} open><summary><code>{call.name}</code> · {call.dispatched ? t("已派送") : t("未派送")}</summary><p className="workflow-meta">{call.id}{call.parentCallId ? ` · parent: ${call.parentCallId}` : ""}</p><pre>{call.args}</pre>{call.output !== undefined ? <pre>{call.output}</pre> : <p>{t("尚無結果")}</p>}</details>) : <p>{t("此 cell 尚無巢狀呼叫")}</p>}</div>}
      {cell.error ? <p className="error-text">{cell.error}</p> : null}
      {cell.truncated ? <p>{t("內容已截斷")}</p> : null}
      {!cell.live && ["started", "running"].includes(cell.status) ? <p>{t("已儲存狀態，未確認仍在執行；無法恢復或停止此 cell。")}</p> : null}
      {cell.canTerminate ? <button disabled={view.busy} onClick={() => setStop(cell.id)}>{t("停止 cell")}</button> : null}
    </article>)}</div>
    {stop ? <div className="workflow-card" role="alertdialog" aria-label={t("確認停止 cell")}><p>{t("停止此 cell 及其巢狀呼叫？")} <code>{stop}</code></p><button onClick={() => setStop(undefined)} disabled={view.busy}>{t("返回")}</button><button disabled={view.busy} onClick={() => {
      const cellId = stop
      void view.act(() => bridge.request({ kind: "desktop/session/execution/stop", workspaceId, sessionId, cellId }), () => setStop(undefined))
    }}>{t("確認停止")}</button></div> : null}
    {view.state ? <div className="workflow-actions"><button disabled={offset === 0 || view.busy} onClick={() => setOffset(Math.max(0, offset - 10))}>{t("較新記錄")}</button><span>{offset + 1}–{Math.min(offset + 10, view.state.total)} / {view.state.total}</span><button disabled={!view.state.hasMore || view.busy} onClick={() => setOffset(offset + 10)}>{t("較舊記錄")}</button></div> : null}
  </section>
}
