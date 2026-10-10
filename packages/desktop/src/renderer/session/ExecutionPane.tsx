import { useId, useRef, useState } from "react"
import { Braces, RefreshCw } from "lucide-react"
import type { DesktopExecutionView, ExecutionCallView, ExecutionRequest } from "@i-harness/desktop-gateway/src/execution.ts"
import { useExecutionSurface } from "./execution-surface.ts"
import { useExecutionText } from "./execution-i18n.ts"
import { useToolText } from "./tool-text.ts"
import { OutputBlock } from "./OutputBlock.tsx"
import { RawRecordedRecord } from "./RawRecordedData.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { PaneTabs } from "../vendor/zcode/PaneTabs.tsx"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import "./execution-processes.css"

type ExecutionPaneProps = { bridge: { request(request: ExecutionRequest): Promise<unknown> }; workspaceId: string; sessionId: string }
type ExecutionTab = "code" | "output" | "trace"

/** Tab choice persists; records, pending replies and confirmations own one scope. */
export function ExecutionPane(props: ExecutionPaneProps) {
  const [tab, setTab] = useState<ExecutionTab>("code")
  return <ExecutionScope key={JSON.stringify([props.workspaceId, props.sessionId])} {...props} tab={tab} setTab={setTab} />
}

function ExecutionScope({ bridge, workspaceId, sessionId, tab, setTab }: ExecutionPaneProps & { tab: ExecutionTab; setTab(tab: ExecutionTab): void }) {
  const t = useExecutionText(), tt = useToolText(), tabsId = useId()
  const [offset, setOffset] = useState(0)
  const [stop, setStop] = useState<{ id: string; label: string }>()
  const [actionError, setActionError] = useState<string>()
  const scope = workspaceId + ":" + sessionId
  const view = useExecutionSurface<DesktopExecutionView>(() => bridge.request({ kind: "desktop/session/execution/read", workspaceId, sessionId, offset, limit: 10 }), scope + ":" + offset, true)
  const current = useRef({ state: view.state, busy: view.busy, stop })
  current.current = { state: view.state, busy: view.busy, stop }
  function canStop(state: DesktopExecutionView | undefined, id: string) {
    const cell = state?.cells.find(cell => cell.id === id)
    return !!(state?.live && state.sessionId === sessionId && cell?.ownerSessionId === sessionId && cell.live && cell.canTerminate)
  }
  async function confirmStop() {
    const target = current.current.stop
    if (!target || current.current.busy || !canStop(current.current.state, target.id)) return
    const generation = view.generation.current
    setActionError(undefined)
    await view.act(async () => {
      try { return await bridge.request({ kind: "desktop/session/execution/stop", workspaceId, sessionId, cellId: target.id }) }
      catch (error) { if (generation === view.generation.current) setActionError(error instanceof Error ? error.message : String(error)); throw error }
    }, () => setStop(undefined))
  }
  const eligible = !!stop && canStop(view.state, stop.id)
  return <section className="workflow-section execution-pane" aria-label={t("執行檢視")}>
    <header className="execution-surface-header"><div><Braces size={18} aria-hidden="true" /><h2>{t("執行檢視")}</h2></div><Button variant="ghost" size="small" disabled={view.busy} icon={<RefreshCw size={14} />} onClick={() => { void view.refresh() }}>{t("重新整理")}</Button></header>
    <p className="execution-surface-note">{view.state?.effectiveMode ? t("目前有效模式") + "：" + view.state.effectiveMode : t("已儲存執行記錄")}</p>
    <PaneTabs id={tabsId} label={t("Cell 內容")} items={([["code", "程式"], ["output", "輸出"], ["trace", "巢狀呼叫"]] as const).map(([id, label]) => ({ id, label: t(label) }))} selected={tab} onSelect={id => setTab(id as ExecutionTab)} />
    {view.error && !stop ? <p role="alert" className="error-text">{view.error}</p> : null}
    {!view.state && !view.error ? <p role="status">{t("正在讀取…")}</p> : null}
    {view.state?.cells.length === 0 ? <p className="execution-surface-empty">{t("尚無 Code Mode cell")}</p> : null}
    <div role="tabpanel" id={tabsId + "-panel"} aria-labelledby={tabsId + "-" + tab} className="execution-record-list">{view.state?.cells.map((cell, index) => <article key={cell.id} className="execution-record-card">
      <div className="execution-record-header"><h3>{tt("執行單元", "Cell")} {offset + index + 1}</h3><span className="execution-record-status">{cell.status} · {cell.live ? t("活躍") : t("歷史")}</span></div>
      {tab === "code" ? cell.source ? <OutputBlock label={tt("JavaScript 原始碼", "JavaScript source")} language="javascript" text={cell.source} /> : <p className="execution-surface-note">{t("此記錄未保存程式")}</p>
        : tab === "output" ? <div className="execution-record-content">{cell.output.length ? cell.output.map((item, index) => <OutputBlock key={String(item.seq ?? index) + ":" + index} label={item.kind === "text" ? tt("執行輸出", "Output") : tt("輸出記錄", "Output record") + " · " + item.kind} text={item.text} />) : <p className="execution-surface-note">{t("此 cell 尚無輸出")}</p>}</div>
          : cell.calls.length ? <ExecutionTrace calls={cell.calls} /> : <p className="execution-surface-note">{t("此 cell 尚無巢狀呼叫")}</p>}
      {cell.error !== undefined ? <OutputBlock label={tt("錯誤記錄", "Recorded error")} text={cell.error} defaultWrap /> : null}
      {cell.truncated ? <p className="execution-surface-note">{t("內容已截斷")}</p> : null}
      {!cell.live && ["started", "running"].includes(cell.status) ? <p className="execution-surface-note">{t("已儲存狀態，未確認仍在執行；無法恢復或停止此 cell。")}</p> : null}
      <RawRecordedRecord value={cell} />
      {canStop(view.state, cell.id) ? <div className="execution-record-actions"><Button variant="danger" size="small" disabled={view.busy} onClick={() => { setActionError(undefined); setStop({ id: cell.id, label: tt("執行單元", "Cell") + " " + (offset + index + 1) }) }}>{t("停止 cell")}</Button></div> : null}
    </article>)}</div>
    {stop ? <SettingsDialog title={t("確認停止 cell")} closeLabel={tt("關閉停止確認", "Close stop confirmation")} busy={view.busy} initialFocusSelector="[data-dialog-cancel]" onClose={() => setStop(undefined)} className="execution-action-dialog"><form onSubmit={event => { event.preventDefault(); void confirmStop() }}>
      <p>{t("停止此 cell 及其巢狀呼叫？")}</p><p className="execution-action-target">{stop.label}</p>
      <details className="execution-identity"><summary>{tt("操作詳情", "Action details")}</summary><dl><dt>Cell ID</dt><dd>{stop.id}</dd><dt>{tt("會話", "Conversation")}</dt><dd>{sessionId}</dd></dl></details>
      {!eligible ? <p role="status" className="execution-surface-note">{tt("此操作目前不可用；執行狀態或控制權已變更。", "This action is unavailable; execution state or control ownership changed.")}</p> : null}
      {actionError || view.error ? <p role="alert" className="error-text">{actionError ?? view.error}</p> : null}
      <div className="execution-dialog-actions"><Button data-dialog-cancel disabled={view.busy} onClick={() => setStop(undefined)}>{t("返回")}</Button><Button type="submit" variant="danger" aria-label={t("確認停止")} disabled={!eligible} loading={view.busy} loadingLabel={tt("正在停止…", "Stopping…")}>{t("確認停止")}</Button></div>
    </form></SettingsDialog> : null}
    {view.state && view.state.total > 0 ? <div className="execution-pagination"><Button size="small" variant="ghost" disabled={offset === 0 || view.busy} onClick={() => setOffset(Math.max(0, offset - 10))}>{t("較新記錄")}</Button><span>{offset + 1}–{Math.min(offset + 10, view.state.total)} / {view.state.total}</span><Button size="small" variant="ghost" disabled={!view.state.hasMore || view.busy} onClick={() => setOffset(offset + 10)}>{t("較舊記錄")}</Button></div> : null}
  </section>
}

function ExecutionTrace({ calls }: { calls: ExecutionCallView[] }) {
  const t = useExecutionText(), tt = useToolText(), [page, setPage] = useState(0)
  const count = Math.ceil(calls.length / 20), current = Math.min(page, count - 1)
  return <div className="execution-record-content">{calls.slice(current * 20, (current + 1) * 20).map(call => <article key={call.id} className="execution-call-card">
    <div className="execution-record-header"><h4><code>{call.name}</code></h4><span className="execution-record-status">{call.isError ? tt("執行失敗", "Failed") : call.output !== undefined ? tt("已收到結果", "Result received") : call.dispatched ? tt("已派發，等待結果", "Dispatched, awaiting result") : t("未派送")}</span></div>
    {call.output !== undefined ? <OutputBlock label={tt("呼叫結果", "Call result")} text={call.output} /> : <p className="execution-surface-note">{t("尚無結果")}</p>}
    <CallArguments value={call.args} /><RawRecordedRecord value={call} />
  </article>)}{count > 1 ? <div className="execution-pagination"><Button size="small" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>{tt("上一頁", "Previous page")}</Button><span>{current + 1} / {count}</span><Button size="small" variant="ghost" disabled={current + 1 === count} onClick={() => setPage(current + 1)}>{tt("下一頁", "Next page")}</Button></div> : null}</div>
}

function CallArguments({ value }: { value: string }) {
  const tt = useToolText(), [open, setOpen] = useState(false)
  return <details className="execution-identity" open={open}><summary onClick={event => { event.preventDefault(); setOpen(current => !current) }}>{tt("呼叫參數", "Invocation arguments")}</summary>{open ? <OutputBlock label={tt("呼叫參數", "Invocation arguments")} text={value} language="JSON" /> : null}</details>
}
