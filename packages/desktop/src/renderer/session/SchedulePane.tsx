import { useCallback, useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale, useText } from "../design/i18n.ts"
import { SettingsDraftScope, useSettingsDraft } from "../settings/settings-drafts.tsx"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import "./workflow.css"

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
interface ReminderDraft { mode: "after" | "at" | "every"; minutes: string; at: string; prompt: string }
interface SchedulePaneProps { bridge: DesktopBridge; workspaceId: string; sessionId: string; canCreate: boolean; active?: boolean }

export function SchedulePane(props: SchedulePaneProps) {
  return <SettingsDraftScope owner={props.bridge}><SessionSchedulePane key={JSON.stringify([props.workspaceId, props.sessionId])} {...props} /></SettingsDraftScope>
}

function SessionSchedulePane({ bridge, workspaceId, sessionId, canCreate, active = true }: SchedulePaneProps) {
  const t = useText()
  const locale = useLocale(state => state.locale)
  const [schedules, setSchedules] = useState<Reminder[]>()
  const [draft, setDraft] = useSettingsDraft<ReminderDraft>(["workflow", workspaceId, sessionId, "reminder"], () => ({ mode: "after", minutes: "10", at: "", prompt: "" }))
  const { mode, minutes, at, prompt } = draft
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [readbackRequired, setReadbackRequired] = useState(false)
  const latestRead = useRef(0)
  const mounted = useRef(false), epoch = useRef(0), lock = useRef(false)
  const visible = useRef(active), writableRef = useRef(false)
  visible.current = active
  const [notice, setNotice] = useState<string>()
  const readback = useRef(false)
  readback.current = readbackRequired
  function edit(patch: Partial<ReminderDraft>) { setDraft({ ...draft, ...patch }) }
  useEffect(() => {
    mounted.current = true; epoch.current++
    return () => { mounted.current = false; epoch.current++; latestRead.current++ }
  }, [])

  const refresh = useCallback(async (force = false) => {
    if (!mounted.current || !force && !visible.current) return false
    const own = epoch.current
    const ticket = ++latestRead.current
    try {
      const result = await bridge.request({ kind: "desktop/schedule/list", workspaceId, sessionId }) as { schedules: Reminder[] }
      if (!mounted.current || own !== epoch.current || ticket !== latestRead.current) return false
      setSchedules(result.schedules)
      setReadbackRequired(false)
      readback.current = false
      return true
    } catch (reason) {
      if (!mounted.current || own !== epoch.current || ticket !== latestRead.current) return false
      throw reason
    }
  }, [bridge, workspaceId, sessionId])

  useEffect(() => {
    if (!active) return
    let subscribed = true
    void refresh().then(read => { if (subscribed && read && !lock.current) setError(undefined) }).catch((reason: unknown) => { if (subscribed && mounted.current) setError(String(reason)) })
    const unsubscribe = bridge.onEvent((message) => {
      if (message.kind !== "sdk/notification" || message.workspaceId !== workspaceId || message.method !== "session/event") return
      const params = message.params as { sessionId?: unknown; event?: { type?: unknown } } | undefined
      if (params?.sessionId === sessionId && params.event?.type === "schedule/change" && !lock.current) void refresh().catch((reason: unknown) => { if (subscribed && mounted.current) setError(String(reason)) })
    })
    return () => { subscribed = false; unsubscribe() }
  }, [bridge, workspaceId, sessionId, refresh, active])

  async function mutate(request: Parameters<DesktopBridge["request"]>[0]) {
    if (lock.current || readback.current || !mounted.current || !visible.current || !writableRef.current) return false
    const own = epoch.current
    lock.current = true
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    setReadbackRequired(true)
    readback.current = true
    let mutationError: string | undefined
    try { await bridge.request(request) }
    catch (reason) { mutationError = reason instanceof Error ? reason.message : String(reason) }
    // A failed flush can leave a durable event. Never unlock another write
    // unless a current list read has confirmed the resulting state.
    if (!mounted.current || own !== epoch.current) return false
    try { await refresh(true); if (!mounted.current || own !== epoch.current) return false; setError(mutationError) }
    catch (reason) {
      setReadbackRequired(true)
      readback.current = true
      const readError = reason instanceof Error ? reason.message : String(reason)
      setError([mutationError, `${t("重新讀取提醒失敗，請先重試。")} ${readError}`].filter(Boolean).join("；"))
    }
    setBusy(false)
    lock.current = false
    return mutationError === undefined
  }

  async function retryRead() {
    if (lock.current || !mounted.current || !visible.current) return
    const own = epoch.current
    lock.current = true
    setBusy(true)
    try { if (await refresh()) setError(undefined) }
    catch (reason) { if (mounted.current && own === epoch.current) { setReadbackRequired(true); readback.current = true; setError(`${t("重新讀取提醒失敗，請先重試。")} ${reason instanceof Error ? reason.message : String(reason)}`) } }
    finally { if (mounted.current && own === epoch.current) { setBusy(false); lock.current = false } }
  }

  async function create() {
    if (!writableRef.current || lock.current || readback.current || !visible.current) return
    const text = prompt.trim()
    if (!text || text.length > 4096) { setError(t("提醒內容須為 1 至 4096 字。")); return }
    const command: ReminderCommand = { prompt: text }
    if (mode === "at") {
      const instant = new Date(at)
      if (!at || Number.isNaN(instant.getTime()) || instant.getTime() <= Date.now()) { setError(t("請選擇未來的日期與時間。")); return }
      command.at = instant.toISOString()
    } else {
      const count = Number(minutes)
      if (!Number.isSafeInteger(count) || !Number.isSafeInteger(count * 60) || count < (mode === "every" ? 5 : 1)) { setError(t(mode === "every" ? "重複間隔至少 5 分鐘。" : "延遲至少 1 分鐘。")); return }
      if (mode === "after") command.after_seconds = count * 60
      else command.every_seconds = count * 60
    }
    if (await mutate({ kind: "desktop/schedule/create", workspaceId, sessionId, command })) { setDraft(current => current.prompt === prompt ? { ...current, prompt: "" } : current); setNotice(locale === "en" ? "Reminder request accepted." : "提醒請求已接受。") }
  }

  async function remove(id: string) {
    if (await mutate({ kind: "desktop/schedule/delete", workspaceId, sessionId, id })) { setConfirmDelete(undefined); setNotice(locale === "en" ? "Reminder deletion accepted." : "提醒刪除請求已接受。") }
  }

  const writable = active && canCreate && schedules !== undefined && !readbackRequired
  writableRef.current = writable
  const deleting = schedules?.find(row => row.id === confirmDelete)

  return <section className="schedule-pane" aria-label={t("此會話提醒")}>
    <h3 className="review-title">{t("此會話提醒")}</h3>
    <p className="schedule-notice">{t("到期後在下一個 Agent 步驟處理；不會在閒置時自動喚醒會話。")}</p>
    {error && !confirmDelete ? <p role="alert" className="error-text">{error}</p> : null}
    {notice ? <p role="status" className="workflow-hint">{notice}</p> : null}
    {(readbackRequired || schedules === undefined && error) && !confirmDelete ? <Button size="small" disabled={busy || !active} onClick={() => void retryRead()}>{t("重新讀取提醒")}</Button> : null}
    {schedules === undefined ? !error && active ? <p role="status" className="muted">{t("正在讀取提醒…")}</p> : null
      : schedules.length === 0 ? <p className="muted">{t("此會話尚無提醒")}</p>
        : <ul className="schedule-list">{schedules.map((schedule) => <li key={schedule.id} className="schedule-card">
          <div><strong>{schedule.prompt}</strong><small>{t(schedule.kind === "every" ? "重複" : "單次")} · {new Date(schedule.scheduledAt).toLocaleString(locale)} · {t(schedule.state === "overdue" ? "已到期，等候下一步" : "已排定")}</small></div>
          <Button size="small" disabled={busy || !writable} onClick={() => setConfirmDelete(schedule.id)}>{t("刪除提醒")}</Button>
        </li>)}</ul>}
    {!canCreate ? <p className="muted">{t("選擇模型並等候會話閒置後才能管理提醒。")}</p> : null}<form className="schedule-form" onSubmit={(event) => { event.preventDefault(); void create() }}>
      <label>{t("提醒內容")}<textarea value={prompt} maxLength={4096} disabled={busy || !active} onChange={(event) => edit({ prompt: event.target.value })} aria-label={t("提醒內容")} /></label>
      <label>{t("提醒方式")}<select aria-label={t("提醒方式")} value={mode} disabled={busy || !active} onChange={(event) => { const next = event.target.value as typeof mode; edit({ mode: next, minutes: next === "every" ? "5" : "10" }) }}>
        <option value="after">{t("延遲一次")}</option><option value="at">{t("指定時間")}</option><option value="every">{t("定期重複")}</option>
      </select></label>
      {mode === "at" ? <label>{t("日期與時間")}<input type="datetime-local" aria-label={t("日期與時間")} value={at} disabled={busy || !active} onChange={(event) => edit({ at: event.target.value })} /></label>
        : <label>{t(mode === "every" ? "間隔分鐘" : "延遲分鐘")}<input type="number" min={mode === "every" ? 5 : 1} step={1} aria-label={t(mode === "every" ? "間隔分鐘" : "延遲分鐘")} value={minutes} disabled={busy || !active} onChange={(event) => edit({ minutes: event.target.value })} /></label>}
      <Button type="submit" variant="primary" loading={busy} disabled={!writable || !prompt.trim()}>{t("建立提醒")}</Button>
    </form>
    {active && confirmDelete ? <SettingsDialog title={t("確認刪除提醒")} closeLabel={t("關閉")} busy={busy} onClose={() => setConfirmDelete(undefined)} initialFocusSelector="button.schedule-return">
      <p className="workflow-objective">{deleting?.prompt ?? (locale === "en" ? "This reminder is no longer in the list." : "此提醒已不在列表中。")}</p>
      {error ? <p role="alert" className="error-text">{error}<Button size="small" disabled={busy} onClick={() => { void retryRead() }}>{t("重新讀取提醒")}</Button></p> : null}
      <div className="workflow-actions"><Button className="schedule-return" disabled={busy} onClick={() => setConfirmDelete(undefined)}>{t("取消")}</Button><Button variant="danger" loading={busy} disabled={!writable || !deleting} onClick={() => { if (deleting) void remove(deleting.id) }}>{t("確認刪除提醒")}</Button></div>
    </SettingsDialog> : null}
  </section>
}
