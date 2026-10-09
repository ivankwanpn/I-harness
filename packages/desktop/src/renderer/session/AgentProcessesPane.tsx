import { useRef, useState } from "react"
import { RefreshCw, Terminal } from "lucide-react"
import type { AgentProcessCommand, AgentProcessesRequest, AgentProcessesView } from "@i-harness/desktop-gateway/src/agent-processes.ts"
import { useExecutionSurface } from "./execution-surface.ts"
import { useExecutionText } from "./execution-i18n.ts"
import { useToolText } from "./tool-text.ts"
import { OutputBlock } from "./OutputBlock.tsx"
import { RawRecordedRecord } from "./RawRecordedData.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import "./execution-processes.css"

type AgentProcessesPaneProps = { bridge: { request(request: AgentProcessesRequest): Promise<unknown> }; workspaceId: string; sessionId: string }
interface Output { id: string; kind: "terminal" | "job"; text: string; nextOffset?: number; mode: "offset" | "snapshot"; truncated: boolean; dropped: boolean; historical: boolean; reason?: string; label: string; record: unknown }

/** Size preferences persist; output, drafts and confirmations belong to scope. */
export function AgentProcessesPane(props: AgentProcessesPaneProps) {
  const [cols, setCols] = useState(80), [rows, setRows] = useState(24)
  return <ProcessesScope key={JSON.stringify([props.workspaceId, props.sessionId])} {...props} cols={cols} rows={rows} setCols={setCols} setRows={setRows} />
}

function ProcessesScope({ bridge, workspaceId, sessionId, cols, rows, setCols, setRows }: AgentProcessesPaneProps & { cols: number; rows: number; setCols(value: number): void; setRows(value: number): void }) {
  const t = useExecutionText(), tt = useToolText()
  const view = useExecutionSurface<AgentProcessesView>(() => bridge.request({ kind: "desktop/session/processes/read", workspaceId, sessionId }), workspaceId + ":" + sessionId, true)
  const [output, setOutput] = useState<Output>()
  const [drafts, setDrafts] = useState(new Map<string, string>())
  const [confirm, setConfirm] = useState<{ command: AgentProcessCommand; label: string }>()
  const [actionError, setActionError] = useState<string>()
  const outputTicket = useRef(0)
  const current = useRef({ state: view.state, busy: view.busy, confirm }); current.current = { state: view.state, busy: view.busy, confirm }
  const control = (command: AgentProcessCommand) => bridge.request({ kind: "desktop/session/processes/control", workspaceId, sessionId, command })
  function terminalFor(id: string, state = current.current.state) { return state?.sessionId === sessionId ? state.terminals.find(row => row.id === id && row.ownerSessionId === sessionId) : undefined }
  function jobFor(id: string, state = current.current.state) { return state?.sessionId === sessionId ? state.jobs.find(row => row.jobId === id && row.ownerSessionId === sessionId) : undefined }
  function canControl(command: Pick<AgentProcessCommand, "action" | "id">, state = current.current.state) {
    if (!state?.live || state.sessionId !== sessionId) return false
    if (command.action === "job/cancel") { const job = jobFor(command.id, state); return !!(job?.live && job.canCancel) }
    const terminal = terminalFor(command.id, state)
    return !!(terminal?.live && terminal.canControl)
  }
  function attach(id: string, kind: Output["kind"], more = false) {
    const state = current.current.state, terminal = kind === "terminal" ? terminalFor(id, state) : undefined, job = kind === "job" ? jobFor(id, state) : undefined
    const target = terminal ?? job
    if (!target || current.current.busy || !(target.live || target.outputAvailable)) return
    const liveOffset = !!(terminal?.live && state?.live)
    const before = more && liveOffset && output?.id === id && output.kind === kind && output.mode === "offset" ? output : undefined
    let ticket = 0
    void view.act(async () => {
      // Allocate a read ticket only after the shared operation gate admits it.
      ticket = ++outputTicket.current
      const value = await (kind === "terminal" ? liveOffset ? control({ action: "read", id, offset: before?.nextOffset ?? 0 }) : bridge.request({ kind: "desktop/session/processes/terminal-output", workspaceId, sessionId, id }) : bridge.request({ kind: "desktop/session/processes/job-output", workspaceId, sessionId, id }))
      const result = value as { ownerSessionId?: string }
      if (result?.ownerSessionId !== undefined && result.ownerSessionId !== sessionId) throw new Error(tt("輸出不屬於目前會話。", "Output does not belong to this conversation."))
      return value
    }, value => {
      if (ticket !== outputTicket.current) return
      const result = value as { text?: string; data?: string; nextOffset?: number; truncated?: boolean; dropped?: boolean; reason?: string; live?: boolean }
      const nextOffset = typeof result.nextOffset === "number" && Number.isSafeInteger(result.nextOffset) && result.nextOffset >= 0 ? result.nextOffset : undefined
      const offsetData = liveOffset && typeof result.data === "string" && nextOffset !== undefined && result.live !== false
      const previous = offsetData ? before : undefined
      const text = (previous?.text ?? "") + (result.data ?? result.text ?? "")
      const clipped = text.length > 131072
      setOutput({ id, kind, text: text.slice(-131072), nextOffset, mode: offsetData ? "offset" : "snapshot",
        truncated: result.truncated === true || previous?.truncated === true || clipped, dropped: result.dropped === true || previous?.dropped === true || clipped,
        historical: typeof result.live === "boolean" ? !result.live : !target.live, reason: result.reason,
        label: terminal?.command || job?.label || (kind === "terminal" ? tt("PTY 程序", "PTY process") : t("背景工作")), record: value })
    }, false)
  }
  function setDraft(value: string) {
    if (output?.kind !== "terminal") return
    setDrafts(current => new Map(current).set(output.id, value))
  }
  async function confirmAction() {
    const target = current.current.confirm
    if (!target || current.current.busy || !canControl(target.command)) return
    const generation = view.generation.current
    setActionError(undefined)
    await view.act(async () => {
      try { return await control(target.command) }
      catch (error) { if (generation === view.generation.current) setActionError(error instanceof Error ? error.message : String(error)); throw error }
    }, () => setConfirm(undefined))
  }
  function openConfirmation(command: AgentProcessCommand, label: string) {
    if (current.current.busy || !canControl(command)) return
    setActionError(undefined); setConfirm({ command, label })
  }
  const selected = output?.kind === "terminal" ? terminalFor(output.id) : undefined
  const selectedJob = output?.kind === "job" ? jobFor(output.id) : undefined
  const draft = output?.kind === "terminal" ? drafts.get(output.id) ?? "" : ""
  const editable = !!(output?.kind === "terminal" && selected && canControl({ action: "send", id: output.id }))
  const eligible = !!confirm && canControl(confirm.command)
  const actionDescription = confirm?.command.action === "job/cancel" ? tt("取消此背景工作？", "Cancel this background job?") : confirm?.command.action === "close" ? tt("關閉此程序？", "Close this process?") : confirm?.command.action === "signal" && confirm.command.signal === "INT" ? tt("傳送 Ctrl+C 到此程序？", "Send Ctrl+C to this process?") : confirm?.command.action === "signal" && confirm.command.signal === "KILL" ? tt("強制終止此程序？", "Force terminate this process?") : tt("終止此程序？", "Terminate this process?")
  return <section className="workflow-section agent-processes-pane" aria-label={t("Agent 程序與背景工作")}>
    <header className="execution-surface-header"><div><Terminal size={18} aria-hidden="true" /><h2>{t("Agent 程序與背景工作")}</h2></div><Button variant="ghost" size="small" disabled={view.busy} icon={<RefreshCw size={14} />} onClick={() => { void view.refresh() }}>{t("重新整理")}</Button></header>
    {view.error && !confirm ? <p role="alert" className="error-text">{view.error}</p> : null}
    {!view.state && !view.error ? <p role="status">{t("正在讀取…")}</p> : null}
    <h3>{t("Agent PTY／程序")}</h3>
    {view.state?.terminals.length === 0 ? <p className="execution-surface-empty">{t("目前沒有此會話擁有的 PTY 程序")}</p> : null}
    <div className="execution-record-list">{view.state?.terminals.map((row, index) => <article key={row.id} className="execution-record-card">
      <div className="execution-record-header"><h4>{row.command || tt("PTY 程序", "PTY process") + " " + (index + 1)}</h4><span className="execution-record-status">{row.status} · {row.live ? t("活躍") : t("歷史")}</span></div>
      {!row.live && row.status === "running" ? <p className="execution-surface-note">{t("已儲存狀態，未確認仍在執行")}</p> : null}
      {row.outputReason ? <p className="execution-surface-note">{row.outputReason}</p> : null}
      <div className="execution-record-actions">{terminalFor(row.id) && (row.live || row.outputAvailable) ? <Button size="small" disabled={view.busy} onClick={() => attach(row.id, "terminal")}>{t(row.live ? "附接輸出" : "查看輸出")}</Button> : null}
        {canControl({ action: "close", id: row.id }) ? <><Button size="small" disabled={view.busy} onClick={() => openConfirmation({ action: "signal", id: row.id, signal: "INT" }, row.command ?? tt("PTY 程序", "PTY process"))}>Ctrl+C</Button><Button variant="danger" size="small" disabled={view.busy} onClick={() => openConfirmation({ action: "signal", id: row.id, signal: "TERM" }, row.command ?? tt("PTY 程序", "PTY process"))}>{t("終止程序")}</Button><Button variant="danger" size="small" disabled={view.busy} onClick={() => openConfirmation({ action: "signal", id: row.id, signal: "KILL" }, row.command ?? tt("PTY 程序", "PTY process"))}>{t("強制終止")}</Button><Button size="small" disabled={view.busy} onClick={() => openConfirmation({ action: "close", id: row.id }, row.command ?? tt("PTY 程序", "PTY process"))}>{t("關閉程序")}</Button></> : null}
      </div><RawRecordedRecord value={row} />
    </article>)}</div>
    <h3>{t("背景工作")}</h3>
    {view.state?.jobs.length === 0 ? <p className="execution-surface-empty">{t("尚無背景工作")}</p> : null}
    <div className="execution-record-list">{view.state?.jobs.map(job => <article key={job.jobId} className="execution-record-card">
      <div className="execution-record-header"><h4>{job.label}</h4><span className="execution-record-status">{job.status} · {job.live ? t("活躍") : t("歷史")}</span></div>
      {!job.live && job.status === "running" ? <p className="execution-surface-note">{t("已儲存狀態，未確認仍在執行")}</p> : null}
      <div className="execution-record-actions">{jobFor(job.jobId) && (job.outputAvailable || job.live) ? <Button size="small" disabled={view.busy} onClick={() => attach(job.jobId, "job")}>{t("查看輸出")}</Button> : null}{canControl({ action: "job/cancel", id: job.jobId }) ? <Button variant="danger" size="small" disabled={view.busy} onClick={() => openConfirmation({ action: "job/cancel", id: job.jobId }, job.label)}>{t("取消工作")}</Button> : null}</div><RawRecordedRecord value={job} />
    </article>)}</div>
    {output ? <section className="execution-record-card process-output-card" aria-label={t("程序輸出")}><div className="execution-record-header"><h3>{output.label}</h3><Button variant="ghost" size="small" disabled={view.busy} onClick={() => { outputTicket.current++; setOutput(undefined) }}>{t("關閉輸出")}</Button></div>
      <OutputBlock label={t("程序輸出")} text={output.text} />
      {output.mode === "snapshot" ? <p className="execution-surface-note">{tt("每次讀取會更新這份輸出快照。", "Each read replaces this output snapshot.")}</p> : null}
      {output.dropped ? <p className="execution-surface-note">{t("較早輸出已離開保留視窗")}</p> : null}{output.truncated ? <p className="execution-surface-note">{t("輸出已截斷")}</p> : null}
      {output.reason ? <p className="execution-surface-note">{output.reason}</p> : null}
      <div className="execution-record-actions">{output.kind === "terminal" && output.mode === "offset" && selected?.live && view.state?.live ? <Button size="small" disabled={view.busy} onClick={() => attach(output.id, output.kind, true)}>{t("讀取後續輸出")}</Button> : output.kind === "job" && selectedJob && (selectedJob.live || selectedJob.outputAvailable) ? <Button size="small" disabled={view.busy} onClick={() => attach(output.id, output.kind, true)}>{tt("重新讀取輸出", "Refresh output")}</Button> : null}</div>
      {editable ? <><div className="process-input-editor"><label>{t("終端輸入")}<textarea className="ih-control" aria-label={t("終端輸入")} data-terminal-id={output.id} value={draft} maxLength={32767} onChange={event => setDraft(event.target.value)} /></label><Button disabled={view.busy || !draft} onClick={() => {
        if (current.current.busy || !canControl({ action: "send", id: output.id })) return
        const sent = draft, id = output.id
        void view.act(() => control({ action: "send", id, data: sent.replace(/\r?\n/g, "\r") + "\r" }), () => setDrafts(current => {
          if (current.get(id) !== sent) return current
          const next = new Map(current); next.delete(id); return next
        }))
      }}>{t("送出輸入")}</Button></div>
        <div className="process-resize-controls"><label>{t("欄數")}<input className="ih-control" aria-label={t("欄數")} type="number" min={2} max={500} value={cols} onChange={event => setCols(Number(event.target.value))} /></label><label>{t("列數")}<input className="ih-control" aria-label={t("列數")} type="number" min={2} max={500} value={rows} onChange={event => setRows(Number(event.target.value))} /></label><Button size="small" disabled={view.busy || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 500} onClick={() => {
          if (current.current.busy || !canControl({ action: "resize", id: output.id }) || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 500) return
          void view.act(() => control({ action: "resize", id: output.id, cols, rows }))
        }}>{t("調整 PTY 大小")}</Button></div>
      </> : null}
      <RawRecordedRecord value={output.record} />
    </section> : null}
    {confirm ? <SettingsDialog title={t("確認程序操作")} closeLabel={tt("關閉程序確認", "Close process confirmation")} busy={view.busy} initialFocusSelector="[data-dialog-cancel]" onClose={() => setConfirm(undefined)} className="execution-action-dialog"><form onSubmit={event => { event.preventDefault(); void confirmAction() }}>
      <p>{actionDescription}</p><p className="execution-action-target">{confirm.label}</p>
      <details className="execution-identity"><summary>{tt("操作詳情", "Action details")}</summary><dl><dt>ID</dt><dd>{confirm.command.id}</dd><dt>{tt("操作", "Action")}</dt><dd>{confirm.command.action}{confirm.command.action === "signal" ? " · " + confirm.command.signal : ""}</dd><dt>{tt("會話", "Conversation")}</dt><dd>{sessionId}</dd></dl></details>
      {!eligible ? <p role="status" className="execution-surface-note">{tt("此操作目前不可用；執行狀態或控制權已變更。", "This action is unavailable; execution state or control ownership changed.")}</p> : null}
      {actionError || view.error ? <p role="alert" className="error-text">{actionError ?? view.error}</p> : null}
      <div className="execution-dialog-actions"><Button data-dialog-cancel disabled={view.busy} onClick={() => setConfirm(undefined)}>{t("返回")}</Button><Button type="submit" variant="danger" aria-label={t("確認執行")} disabled={!eligible} loading={view.busy} loadingLabel={tt("正在處理…", "Working…")}>{t("確認執行")}</Button></div>
    </form></SettingsDialog> : null}
  </section>
}
