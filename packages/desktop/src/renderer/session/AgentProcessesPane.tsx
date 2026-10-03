import { useEffect, useRef, useState } from "react"
import type { AgentProcessCommand, AgentProcessesRequest, AgentProcessesView } from "@i-harness/desktop-gateway/src/agent-processes.ts"
import { useExecutionSurface } from "./execution-surface.ts"
import { useExecutionText } from "./execution-i18n.ts"

interface Output { id: string; kind: "terminal" | "job"; text: string; nextOffset: number; truncated: boolean; dropped?: boolean; historical?: boolean; reason?: string }
export function AgentProcessesPane({ bridge, workspaceId, sessionId }: { bridge: { request(request: AgentProcessesRequest): Promise<unknown> }; workspaceId: string; sessionId: string }) {
  const t = useExecutionText()
  const scope = `${workspaceId}:${sessionId}`
  const view = useExecutionSurface<AgentProcessesView>(() => bridge.request({ kind: "desktop/session/processes/read", workspaceId, sessionId }), scope, true)
  const [output, setOutput] = useState<Output>()
  const [draft, setDraft] = useState("")
  const [cols, setCols] = useState(80); const [rows, setRows] = useState(24)
  const [confirm, setConfirm] = useState<AgentProcessCommand>()
  const outputTicket = useRef(0)
  useEffect(() => { outputTicket.current++; setOutput(undefined); setDraft(""); setConfirm(undefined) }, [scope])
  const control = (command: AgentProcessCommand) => bridge.request({ kind: "desktop/session/processes/control", workspaceId, sessionId, command })
  function attach(id: string, kind: Output["kind"], more = false) {
    const ticket = ++outputTicket.current
    const before = more && output?.id === id && output.kind === kind ? output : undefined
    const historical = kind === "terminal" && view.state?.terminals.find(row => row.id === id)?.live === false
    void view.act(() => kind === "terminal" ? historical ? bridge.request({ kind: "desktop/session/processes/terminal-output", workspaceId, sessionId, id }) : control({ action: "read", id, offset: before?.nextOffset ?? 0 }) : bridge.request({ kind: "desktop/session/processes/job-output", workspaceId, sessionId, id }), value => {
      if (ticket !== outputTicket.current) return
      const result = value as { text?: string; data?: string; nextOffset?: number; truncated: boolean; dropped?: boolean; reason?: string }
      const text = `${before?.text ?? ""}${result.data ?? result.text ?? ""}`
      setOutput({ id, kind, text: text.slice(-131072), nextOffset: result.nextOffset ?? 0, truncated: result.truncated || text.length > 131072, dropped: result.dropped || before?.dropped, historical, reason: result.reason })
    }, false)
  }
  const selected = view.state?.terminals.find(row => row.id === output?.id)
  return <section className="workflow-section" aria-label={t("Agent 程序與背景工作")}>
    <div className="workflow-heading"><h2>{t("Agent 程序與背景工作")}</h2><button disabled={view.busy} onClick={() => { void view.refresh() }}>{t("重新整理")}</button></div>
    {view.error ? <p role="alert" className="error-text">{view.error}</p> : null}
    {!view.state && !view.error ? <p role="status">{t("正在讀取…")}</p> : null}
    <h3>{t("Agent PTY／程序")}</h3>
    {view.state?.terminals.length === 0 ? <p>{t("目前沒有此會話擁有的 PTY 程序")}</p> : null}
    {view.state?.terminals.map(row => <article key={row.id} className="workflow-card"><h4><code>{row.command ?? row.id}</code>{row.pid !== undefined ? ` · PID ${row.pid}` : ""}</h4><p className="workflow-meta">{row.id} · owner: {row.ownerSessionId} · {row.status}{row.cols !== undefined && row.rows !== undefined ? ` · ${row.cols}×${row.rows}` : ""} · {row.live ? t("活躍") : t("歷史")}</p>
      {!row.live && row.status === "running" ? <p>{t("已儲存狀態，未確認仍在執行")}</p> : null}
      {row.outputReason ? <p>{row.outputReason}</p> : null}
      <div className="workflow-actions">{row.live || row.outputAvailable ? <button disabled={view.busy} onClick={() => attach(row.id, "terminal")}>{t(row.live ? "附接輸出" : "查看輸出")}</button> : null}
        {row.canControl ? <><button disabled={view.busy} onClick={() => setConfirm({ action: "signal", id: row.id, signal: "INT" })}>Ctrl+C</button><button disabled={view.busy} onClick={() => setConfirm({ action: "signal", id: row.id, signal: "TERM" })}>{t("終止程序")}</button><button disabled={view.busy} onClick={() => setConfirm({ action: "signal", id: row.id, signal: "KILL" })}>{t("強制終止")}</button><button disabled={view.busy} onClick={() => setConfirm({ action: "close", id: row.id })}>{t("關閉程序")}</button></> : null}
      </div></article>)}
    <h3>{t("背景工作")}</h3>
    {view.state?.jobs.length === 0 ? <p>{t("尚無背景工作")}</p> : null}
    {view.state?.jobs.map(job => <article key={job.jobId} className="workflow-card"><h4>{job.label}</h4><p className="workflow-meta">{job.jobId} · owner: {job.ownerSessionId} · {job.status} · {job.live ? t("活躍") : t("歷史")}</p>
      {!job.live && job.status === "running" ? <p>{t("已儲存狀態，未確認仍在執行")}</p> : null}
      <div className="workflow-actions">{job.outputAvailable || job.live ? <button disabled={view.busy} onClick={() => attach(job.jobId, "job")}>{t("查看輸出")}</button> : null}{job.canCancel ? <button disabled={view.busy} onClick={() => setConfirm({ action: "job/cancel", id: job.jobId })}>{t("取消工作")}</button> : null}</div></article>)}
    {output ? <section className="workflow-card"><div className="workflow-heading"><h3>{t("程序輸出")} · {output.id}</h3><button disabled={view.busy} onClick={() => { outputTicket.current++; setOutput(undefined) }}>{t("關閉輸出")}</button></div><pre>{output.text || t("尚無輸出")}</pre>
      {output.dropped ? <p>{t("較早輸出已離開保留視窗")}</p> : null}{output.truncated ? <p>{t("輸出已截斷")}</p> : null}
      {output.reason ? <p>{output.reason}</p> : null}
      {!output.historical ? <button disabled={view.busy} onClick={() => attach(output.id, output.kind, true)}>{t("讀取後續輸出")}</button> : null}
      {output.kind === "terminal" && selected?.canControl ? <><label>{t("終端輸入")}<textarea aria-label={t("終端輸入")} value={draft} maxLength={32767} onChange={event => setDraft(event.target.value)} /></label><button disabled={view.busy || !draft} onClick={() => {
        const sent = draft
        // The line editor sends terminal Enter (CR), including pasted breaks.
        // Raw tool callers continue to choose their own bytes.
        void view.act(() => control({ action: "send", id: output.id, data: `${sent.replace(/\r?\n/g, "\r")}\r` }), () => setDraft(current => current === sent ? "" : current))
      }}>{t("送出輸入")}</button>
        <div><label>{t("欄數")}<input aria-label={t("欄數")} type="number" min={2} max={500} value={cols} onChange={event => setCols(Number(event.target.value))} /></label><label>{t("列數")}<input aria-label={t("列數")} type="number" min={2} max={500} value={rows} onChange={event => setRows(Number(event.target.value))} /></label><button disabled={view.busy || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 500} onClick={() => { void view.act(() => control({ action: "resize", id: output.id, cols, rows })) }}>{t("調整 PTY 大小")}</button></div>
      </> : null}
    </section> : null}
    {confirm ? <div role="alertdialog" aria-label={t("確認程序操作")} className="workflow-card"><p>{t("確認對此 owner 的程序／工作執行操作？")} <code>{confirm.id}</code> · {confirm.action}{confirm.action === "signal" ? ` ${confirm.signal}` : ""}</p><button disabled={view.busy} onClick={() => setConfirm(undefined)}>{t("返回")}</button><button disabled={view.busy} onClick={() => { void view.act(() => control(confirm), () => setConfirm(undefined)) }}>{t("確認執行")}</button></div> : null}
  </section>
}
