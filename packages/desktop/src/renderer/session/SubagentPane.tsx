import type { DesktopBridge } from "../../shared/bridge.ts"
import type { HistoryRange } from "@i-harness/sdk"
import type { DesktopSubagentCatalog, DesktopSubagentControl, DesktopSubagentControlResult, DesktopSubagentRow, DesktopSubagentStatus } from "@i-harness/desktop-gateway/src/session-subagents.ts"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Bot, ChevronRight, GitBranch, MessageSquare, RefreshCw, Send, Square, X } from "lucide-react"
import { useText, type Message } from "../design/i18n.ts"
import { Timeline } from "./Timeline.tsx"
import { projectTimeline } from "./project.ts"
import { loadRecentHistory, type HistoryLoad } from "./history.ts"
import { createRefreshScheduler } from "./refresh-scheduler.ts"
import { classifyNotification } from "./notifications.ts"
import "./SubagentPane.css"
export interface SubagentPaneProps {
  bridge: DesktopBridge
  workspaceId: string
  sessionId: string
  parentTitle?: string
}

const STATUS_LABELS: Record<DesktopSubagentStatus, Message> = {
  queued: "等候中", running: "執行中", waiting: "等待中", completed: "已完成", failed: "已失敗", cancelled: "已取消", unavailable: "不可用",
}
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
type Feedback = { error?: string; notice?: string }
// Exact gateway guidance only. Saved diagnostics and transcript content keep
// their original text, including unknown policy reasons from other peers.
const CONTROL_GUIDANCE = new Map<string, Message>([
  ["This subagent is not active in the current process. Its saved history remains available.", "此子代理目前未在這裡執行，仍可查閱已保存的記錄。"],
  ["Leave Plan Mode before following up with or messaging a subagent.", "請先退出計畫模式，再派發後續任務或傳送訊息給子代理。"],
  ["The parent conversation is archived.", "主會話已封存。"],
])

/** Own presentation informed by DSH ui-subagent's lineage and read-only
 * composer. Runtime ownership/capabilities come exclusively from the gateway. */
export function SubagentPane(props: SubagentPaneProps) {
  return <SubagentSession key={JSON.stringify([props.workspaceId, props.sessionId])} {...props} />
}

function ancestors(row: DesktopSubagentRow, rows: DesktopSubagentRow[], parentId: string): DesktopSubagentRow[] {
  const result: DesktopSubagentRow[] = []
  const seen = new Set([row.sessionId])
  let parent = row.parentSessionId
  while (parent !== parentId && !seen.has(parent)) {
    seen.add(parent)
    const ancestor = rows.find((candidate) => candidate.sessionId === parent)
    if (!ancestor) break
    result.unshift(ancestor)
    parent = ancestor.parentSessionId
  }
  return result
}

function SubagentSession({ bridge, workspaceId, sessionId, parentTitle }: SubagentPaneProps) {
  const t = useText()
  const [catalog, setCatalog] = useState<DesktopSubagentCatalog>()
  const [catalogError, setCatalogError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [history, setHistory] = useState<{ childSessionId: string; value: HistoryLoad }>()
  const [historyError, setHistoryError] = useState<{ childSessionId: string; message: string }>()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({})
  const [busy, setBusy] = useState<string>()
  const [reading, setReading] = useState(false)
  const [readbackRequired, setReadbackRequired] = useState(false)
  const active = useRef(false)
  const epoch = useRef(0)
  const catalogTicket = useRef(0)
  const historyTicket = useRef(0)
  const lock = useRef(false)
  const catalogRef = useRef(catalog)
  catalogRef.current = catalog

  const readCatalog = useCallback(async () => {
    if (!active.current) return false
    const scope = epoch.current
    const ticket = ++catalogTicket.current
    setReading(true)
    try {
      const next = await bridge.request({ kind: "desktop/session/subagents/list", workspaceId, sessionId }) as DesktopSubagentCatalog
      if (!active.current || scope !== epoch.current || ticket !== catalogTicket.current) return false
      if (!next || next.parentSessionId !== sessionId || !Array.isArray(next.agents)) throw new Error("Invalid subagent catalog scope")
      catalogRef.current = next
      setCatalog(next); setCatalogError(undefined); setReadbackRequired(false)
      return true
    } catch (reason) {
      if (active.current && scope === epoch.current && ticket === catalogTicket.current) setCatalogError(errorText(reason))
      throw reason
    } finally {
      if (active.current && scope === epoch.current && ticket === catalogTicket.current) setReading(false)
    }
  }, [bridge, workspaceId, sessionId])

  const readHistory = useCallback(async (childSessionId: string) => {
    if (!active.current || selectedRef.current !== childSessionId) return
    const scope = epoch.current
    const ticket = ++historyTicket.current
    try {
      const value = await loadRecentHistory(async (params) => {
        if (!active.current || scope !== epoch.current || ticket !== historyTicket.current || selectedRef.current !== childSessionId) throw new Error("Subagent selection changed")
        const range = await bridge.request({ kind: "desktop/session/subagents/history", workspaceId, sessionId, childSessionId, ...params }) as HistoryRange
        if (!range || !Array.isArray(range.events) || !Number.isSafeInteger(range.nextSeq) || range.nextSeq < 0) throw new Error("Invalid subagent history")
        return range
      }, { limit: 200, maxEvents: 4000 })
      if (!active.current || scope !== epoch.current || ticket !== historyTicket.current || selectedRef.current !== childSessionId) return
      setHistory({ childSessionId, value }); setHistoryError(undefined)
    } catch (reason) {
      if (active.current && scope === epoch.current && ticket === historyTicket.current && selectedRef.current === childSessionId) setHistoryError({ childSessionId, message: errorText(reason) })
    }
  }, [bridge, workspaceId, sessionId])

  useEffect(() => {
    active.current = true
    epoch.current++
    lock.current = false
    setBusy(undefined)
    setReadbackRequired(true)
    const refresh = createRefreshScheduler(async () => {
      await Promise.allSettled([readCatalog(), ...(selectedRef.current ? [readHistory(selectedRef.current)] : [])])
    })
    const unsubscribe = bridge.onEvent((event) => {
      if (event.kind === "window/state") return
      if (event.workspaceId !== workspaceId) return
      if (event.kind === "sdk/disconnected") { setCatalogError(event.message); return }
      const params = event.params as { sessionId?: unknown } | undefined
      if (typeof params?.sessionId !== "string" || params.sessionId !== sessionId && !catalogRef.current?.agents.some((row) => row.sessionId === params.sessionId)) return
      const kind = classifyNotification(event.method, event.params).kind
      if (kind === "durable" || kind === "status" || event.method === "desktop/workflow/changed") refresh.schedule()
    })
    void readCatalog().catch(() => undefined)
    return () => { active.current = false; epoch.current++; catalogTicket.current++; historyTicket.current++; refresh.dispose(); unsubscribe() }
  }, [bridge, workspaceId, sessionId, readCatalog, readHistory])

  useEffect(() => {
    historyTicket.current++
    setHistory(undefined); setHistoryError(undefined)
    if (selected) void readHistory(selected)
  }, [selected, readHistory])

  const selectedAgent = catalog?.agents.find((row) => row.sessionId === selected)
  const controlGuidance = selectedAgent?.controlReason ? CONTROL_GUIDANCE.get(selectedAgent.controlReason) : undefined
  const displayedHistory = history && history.childSessionId === selected ? history.value : undefined
  const displayedError = historyError && historyError.childSessionId === selected ? historyError.message : undefined
  const rows = useMemo(() => projectTimeline(displayedHistory?.events ?? []), [displayedHistory])
  const disabled = busy !== undefined || reading || readbackRequired || catalogError !== undefined
  const text = selected ? drafts[selected] ?? "" : ""
  const lineage = selectedAgent && catalog ? ancestors(selectedAgent, catalog.agents, sessionId) : []

  async function control(action: DesktopSubagentControl["action"]) {
    if (!selected || lock.current || disabled) return
    const row = catalogRef.current?.agents.find((agent) => agent.sessionId === selected)
    const allowed = action === "followup" ? row?.canFollowup : action === "message" ? row?.canMessage : action === "interrupt" ? row?.canInterrupt : row?.canClose
    if (!allowed || ((action === "followup" || action === "message") && !text.trim())) return
    const childSessionId = selected
    const scope = epoch.current
    const snapshot = text
    lock.current = true
    setBusy(childSessionId)
    setFeedback((current) => ({ ...current, [childSessionId]: {} }))
    try {
      const result = await bridge.request({ kind: "desktop/session/subagents/control", workspaceId, sessionId, childSessionId, action, ...(action === "followup" || action === "message" ? { text: snapshot.trim() } : {}) }) as DesktopSubagentControlResult
      if (!active.current || scope !== epoch.current) return
      if (!result || result.parentSessionId !== sessionId || result.childSessionId !== childSessionId || result.action !== action) throw new Error("Invalid subagent control acknowledgement scope")
      if (action === "followup" || action === "message") setDrafts((current) => current[childSessionId] === snapshot ? { ...current, [childSessionId]: "" } : current)
      setFeedback((current) => ({ ...current, [childSessionId]: { notice: t("已送出子代理操作") } }))
      setReadbackRequired(true)
      try { await readCatalog() }
      catch (reason) { if (active.current && scope === epoch.current) setFeedback((current) => ({ ...current, [childSessionId]: { error: `${t("已送出子代理操作")} · ${t("重新讀取失敗，請重試後再操作。")} ${errorText(reason)}` } })) }
      if (!active.current || scope !== epoch.current) return
      await readHistory(childSessionId)
    } catch (reason) {
      if (!active.current || scope !== epoch.current) return
      let message = errorText(reason)
      setReadbackRequired(true)
      try { await readCatalog() }
      catch (readError) { message += ` · ${t("重新讀取失敗，請重試後再操作。")} ${errorText(readError)}` }
      if (active.current && scope === epoch.current) setFeedback((current) => ({ ...current, [childSessionId]: { error: message } }))
    } finally {
      if (active.current && scope === epoch.current) { lock.current = false; setBusy(undefined) }
    }
  }

  return <section className="subagent-pane" aria-label={t("子代理")}>
    <header className="subagent-pane-header"><h2><GitBranch size={17} aria-hidden="true" />{t("子代理列表")}</h2><button type="button" className="link-button" disabled={busy !== undefined || reading} onClick={() => { void readCatalog().catch(() => undefined); if (selected) void readHistory(selected) }}><RefreshCw size={13} aria-hidden="true" />{t("重新整理")}</button></header>
    {catalogError !== undefined ? <p role="alert" className="notice error-text">{catalogError}</p> : null}
    {catalog?.errors?.map((error, index) => <p role="alert" className="subagent-source-error" key={`${error.sessionId ?? "source"}:${index}`}>{error.sessionId ? <code>{error.sessionId}</code> : null}{error.message}</p>)}
    {selected === undefined ? <>
      {catalog ? <div className="subagent-status-counts">{Object.entries(STATUS_LABELS).map(([status, label]) => {
        const count = catalog.agents.filter((row) => row.status === status).length
        return count ? <span key={status} data-status={status}>{t(label)} <strong>{count}</strong></span> : null
      })}</div> : null}
      {!catalog ? catalogError === undefined ? <p className="muted" role="status">{t("正在讀取子代理…")}</p> : null
        : catalog.agents.length === 0 ? <p className="muted">{t(catalog.errors?.length ? "部分子代理資料無法讀取，請重新整理。" : "尚無子代理")}</p>
          : <ul className="subagent-catalog">{catalog.agents.map((agent) => <li key={agent.sessionId} style={{ marginLeft: `${Math.min(ancestors(agent, catalog.agents, sessionId).length, 6) * 12}px` }}>
            <button type="button" className="subagent-catalog-card" aria-label={t("查看子代理 {name}", { name: agent.label })} onClick={() => setSelected(agent.sessionId)}>
              <Bot size={18} aria-hidden="true" />
              <span className="subagent-card-content"><strong>{agent.label}</strong><span>{agent.roleName}{agent.path ? `${agent.roleName ? " · " : ""}${agent.path}` : ""}</span><small>{agent.modelLabel ?? t("繼承主會話模型")}</small>{agent.finalText ? <span className="subagent-result-preview">{agent.finalText.slice(0, 160)}</span> : null}</span>
              <span className="subagent-status" data-status={agent.status}>{t(STATUS_LABELS[agent.status])}</span><ChevronRight size={13} aria-hidden="true" />
            </button>
          </li>)}</ul>}
    </> : <div className="subagent-detail">
      <nav className="subagent-lineage" aria-label={t("子代理執行記錄")}><button type="button" onClick={() => setSelected(undefined)}>{parentTitle ?? t("主會話")}</button>{lineage.map((ancestor) => <span key={ancestor.sessionId}><ChevronRight size={12} aria-hidden="true" /><button type="button" onClick={() => setSelected(ancestor.sessionId)}>{ancestor.label}</button></span>)}<span><ChevronRight size={12} aria-hidden="true" />{selectedAgent?.label ?? selected}</span></nav>
      <div className="subagent-detail-heading"><button type="button" className="subagent-back" aria-label={t("返回子代理列表")} title={t("返回子代理列表")} onClick={() => setSelected(undefined)}><ArrowLeft size={16} aria-hidden="true" /></button><h3>{selectedAgent?.label ?? selected}</h3>{selectedAgent ? <span className="subagent-status" data-status={selectedAgent.status}>{t(STATUS_LABELS[selectedAgent.status])}</span> : null}</div>
      <p className="subagent-detail-model">{selectedAgent ? selectedAgent.modelLabel ?? t("繼承主會話模型") : t("模型資訊未提供")}</p>
      {selectedAgent?.live === false ? <p className="subagent-recorded">{t("已保存的子代理記錄")}</p> : null}
      {selectedAgent?.controlReason ? <p className="subagent-control-reason">{controlGuidance ? t(controlGuidance) : selectedAgent.controlReason}</p> : null}
      {selectedAgent?.error ? <p role="alert" className="notice error-text">{selectedAgent.error}</p> : null}
      {!selectedAgent ? <p role="status" className="notice">{t("子代理暫時不可用")}</p> : null}
      {displayedError !== undefined ? <p role="alert" className="notice error-text">{t("讀取子代理記錄失敗")}：{displayedError}<button type="button" className="link-button" onClick={() => { void readHistory(selected) }}>{t("重試")}</button></p> : null}
      {displayedHistory?.startSeq ? <p className="subagent-history-bound">{t("顯示最近 {count} 筆記錄", { count: displayedHistory.events.length })}</p> : null}
      <div className="subagent-transcript">{displayedHistory ? rows.length ? <Timeline key={selected} rows={rows} running={selectedAgent?.live === true && selectedAgent.status === "running"} /> : <p className="muted">{t("沒有可顯示的子代理記錄")}</p> : displayedError === undefined ? <p role="status" className="muted">{t("正在讀取…")}</p> : null}</div>
      {selectedAgent?.finalText ? <details className="subagent-final-result"><summary>{t("最終結果")}</summary><pre>{selectedAgent.finalText}</pre></details> : null}
      <div className="subagent-readonly" role="status"><Bot size={16} aria-hidden="true" /><span>{t("子會話為唯讀；可用操作由父會話管理。")}</span></div>
      {feedback[selected]?.error ? <p role="alert" className="notice error-text">{feedback[selected].error}</p> : feedback[selected]?.notice ? <p role="status" className="subagent-action-notice">{feedback[selected].notice}</p> : null}
      {selectedAgent?.canFollowup || selectedAgent?.canMessage ? <label className="subagent-input">{t("子代理輸入")}<textarea rows={3} maxLength={8000} value={text} disabled={disabled} onChange={(event) => setDrafts((current) => ({ ...current, [selected]: event.target.value }))} /></label> : null}
      <div className="subagent-control-actions">
        {selectedAgent?.canFollowup ? <button type="button" className="subagent-primary" disabled={disabled || !text.trim()} onClick={() => { void control("followup") }}><Send size={13} aria-hidden="true" />{t("派發後續任務")}</button> : null}
        {selectedAgent?.canMessage ? <button type="button" disabled={disabled || !text.trim()} onClick={() => { void control("message") }}><MessageSquare size={13} aria-hidden="true" />{t("傳送訊息")}</button> : null}
        {selectedAgent?.canInterrupt ? <button type="button" disabled={disabled} onClick={() => { void control("interrupt") }}><Square size={11} aria-hidden="true" />{t("中斷子代理")}</button> : null}
        {selectedAgent?.canClose ? <button type="button" disabled={disabled} onClick={() => { void control("close") }}><X size={13} aria-hidden="true" />{t("關閉子代理")}</button> : null}
      </div>
    </div>}
  </section>
}
