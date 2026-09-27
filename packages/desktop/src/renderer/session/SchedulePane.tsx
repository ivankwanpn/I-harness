import { useCallback, useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"

type Reminder = {
  id: string
  kind: "after" | "at" | "every"
  prompt: string
  scheduledAt: string
  state: "scheduled" | "overdue"
  afterSeconds?: number
  everySeconds?: number
}

type ReminderCommand = { prompt: string; after_seconds?: number; at?: string; every_seconds?: number }

export function SchedulePane({ bridge, workspaceId, sessionId, canCreate }: {
  bridge: DesktopBridge
  workspaceId: string
  sessionId: string
  canCreate: boolean
}) {
  const t = useText()
  const [schedules, setSchedules] = useState<Reminder[]>()
  const [mode, setMode] = useState<"after" | "at" | "every">("after")
  const [minutes, setMinutes] = useState("10")
  const [at, setAt] = useState("")
  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [readbackRequired, setReadbackRequired] = useState(false)
  const latestRead = useRef(0)

  const refresh = useCallback(async () => {
    const ticket = ++latestRead.current
    try {
      const result = await bridge.request({ kind: "desktop/schedule/list", workspaceId, sessionId }) as { schedules: Reminder[] }
      if (ticket !== latestRead.current) return false
      setSchedules(result.schedules)
      setReadbackRequired(false)
      return true
    } catch (reason) {
      if (ticket !== latestRead.current) return false
      throw reason
    }
  }, [bridge, workspaceId, sessionId])

  useEffect(() => {
    let active = true
    void refresh().catch((reason: unknown) => { if (active) setError(String(reason)) })
    const unsubscribe = bridge.onEvent((message) => {
      if (message.kind !== "sdk/notification" || message.workspaceId !== workspaceId || message.method !== "session/event") return
      const params = message.params as { sessionId?: unknown; event?: { type?: unknown } } | undefined
      if (params?.sessionId === sessionId && params.event?.type === "schedule/change") void refresh().catch((reason: unknown) => setError(String(reason)))
    })
    return () => { active = false; latestRead.current += 1; unsubscribe() }
  }, [bridge, workspaceId, sessionId, refresh])

  async function mutate(request: Parameters<DesktopBridge["request"]>[0]) {
    setBusy(true)
    setError(undefined)
    setReadbackRequired(true)
    let mutationError: string | undefined
    try { await bridge.request(request) }
    catch (reason) { mutationError = reason instanceof Error ? reason.message : String(reason) }
    // A failed flush can leave a durable event. Never unlock another write
    // unless a current list read has confirmed the resulting state.
    try { await refresh(); setError(mutationError) }
    catch (reason) {
      setReadbackRequired(true)
      const readError = reason instanceof Error ? reason.message : String(reason)
      setError([mutationError, `${t("重新讀取提醒失敗，請先重試。")} ${readError}`].filter(Boolean).join("；"))
    }
    setBusy(false)
    return mutationError === undefined
  }

  async function retryRead() {
    setBusy(true)
    try { if (await refresh()) setError(undefined) }
    catch (reason) { setReadbackRequired(true); setError(`${t("重新讀取提醒失敗，請先重試。")} ${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { setBusy(false) }
  }

  async function create() {
    const text = prompt.trim()
    if (!text || text.length > 4096) { setError(t("提醒內容須為 1 至 4096 字。")); return }
    const command: ReminderCommand = { prompt: text }
    if (mode === "at") {
      const instant = new Date(at)
      if (!at || Number.isNaN(instant.getTime()) || instant.getTime() <= Date.now()) { setError(t("請選擇未來的日期與時間。")); return }
      command.at = instant.toISOString()
    } else {
      const count = Number(minutes)
      if (!Number.isSafeInteger(count) || count < (mode === "every" ? 5 : 1)) { setError(t(mode === "every" ? "重複間隔至少 5 分鐘。" : "延遲至少 1 分鐘。")); return }
      if (mode === "after") command.after_seconds = count * 60
      else command.every_seconds = count * 60
    }
    if (await mutate({ kind: "desktop/schedule/create", workspaceId, sessionId, command })) setPrompt("")
  }

  async function remove(id: string) {
    setConfirmDelete(undefined)
    await mutate({ kind: "desktop/schedule/delete", workspaceId, sessionId, id })
  }

  const writable = canCreate && schedules !== undefined && !readbackRequired

  return <section className="schedule-pane" aria-label={t("此會話提醒")}>
    <h3 className="review-title">{t("此會話提醒")}</h3>
    <p className="schedule-notice">{t("到期後在下一個 Agent 步驟處理；不會在閒置時自動喚醒會話。")}</p>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {(readbackRequired || schedules === undefined && error) ? <button type="button" className="oc-button" data-size="small" data-variant="secondary" disabled={busy} onClick={() => void retryRead()}>{t("重新讀取提醒")}</button> : null}
    {schedules === undefined ? <p className="muted">{t("正在讀取提醒…")}</p>
      : schedules.length === 0 ? <p className="muted">{t("此會話尚無提醒")}</p>
        : <ul className="schedule-list">{schedules.map((schedule) => <li key={schedule.id} className="schedule-card">
          <div><strong>{schedule.prompt}</strong><small>{t(schedule.kind === "every" ? "重複" : "單次")} · {new Date(schedule.scheduledAt).toLocaleString()} · {t(schedule.state === "overdue" ? "已到期，等候下一步" : "已排定")}</small></div>
          <button type="button" className="oc-button" data-size="small" data-variant="secondary" disabled={busy || !writable} onClick={() => confirmDelete === schedule.id ? void remove(schedule.id) : setConfirmDelete(schedule.id)}>{t(confirmDelete === schedule.id ? "確認刪除提醒" : "刪除提醒")}</button>
        </li>)}</ul>}
    {!canCreate ? <p className="muted">{t("選擇模型並等候會話閒置後才能管理提醒。")}</p> : <form className="schedule-form" onSubmit={(event) => { event.preventDefault(); if (!busy) void create() }}>
      <label>{t("提醒內容")}<textarea value={prompt} maxLength={4096} disabled={busy} onChange={(event) => setPrompt(event.target.value)} aria-label={t("提醒內容")} /></label>
      <label>{t("提醒方式")}<select aria-label={t("提醒方式")} value={mode} disabled={busy} onChange={(event) => { const next = event.target.value as typeof mode; setMode(next); setMinutes(next === "every" ? "5" : "10") }}>
        <option value="after">{t("延遲一次")}</option><option value="at">{t("指定時間")}</option><option value="every">{t("定期重複")}</option>
      </select></label>
      {mode === "at" ? <label>{t("日期與時間")}<input type="datetime-local" aria-label={t("日期與時間")} value={at} disabled={busy} onChange={(event) => setAt(event.target.value)} /></label>
        : <label>{t(mode === "every" ? "間隔分鐘" : "延遲分鐘")}<input type="number" min={mode === "every" ? 5 : 1} step={1} aria-label={t(mode === "every" ? "間隔分鐘" : "延遲分鐘")} value={minutes} disabled={busy} onChange={(event) => setMinutes(event.target.value)} /></label>}
      <button type="submit" className="oc-button" data-size="normal" data-variant="primary" disabled={busy || !writable || !prompt.trim()}>{t("建立提醒")}</button>
    </form>}
  </section>
}
