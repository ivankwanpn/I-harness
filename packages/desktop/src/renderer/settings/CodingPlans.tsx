import { useCallback, useEffect, useRef, useState } from "react"
import { Check, RefreshCw, UserRound } from "lucide-react"
import type { CodingPlanAccount, CodingPlansRequest, CodingPlansState, OpenAiManagementState } from "../../shared/coding-plans.ts"
import { useLocale, useText } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { SettingsDialog } from "./SettingsDialog.tsx"
import "./CodingPlans.css"

export function CodingPlans({ request, active = true, onManageModels }: {
  request(input: CodingPlansRequest): Promise<CodingPlansState>
  active?: boolean
  onManageModels?(): void
}) {
  const t = useText()
  const [state, setState] = useState<CodingPlansState>()
  const [busy, setBusy] = useState<CodingPlansRequest["kind"]>()
  const [error, setError] = useState<string>()
  const alive = useRef(false)
  const revision = useRef(0)
  const action = useRef<CodingPlansRequest["kind"] | undefined>(undefined)
  const run = useCallback(async (input: CodingPlansRequest, poll = false) => {
    if (!alive.current || (action.current && input.kind !== "desktop/coding-plans/cancel")) return
    const current = ++revision.current
    if (!poll) { action.current = input.kind; setBusy(input.kind); setError(undefined) }
    try {
      const next = await request(input)
      if (!alive.current || current !== revision.current) return
      setState(next)
      setError(undefined)
      return next
    } catch (reason) {
      if (alive.current && current === revision.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!poll && alive.current && current === revision.current) { action.current = undefined; setBusy(undefined) }
    }
  }, [request])

  useEffect(() => {
    alive.current = active
    action.current = undefined
    setBusy(undefined)
    setState(undefined)
    setError(undefined)
    if (active) void run({ kind: "desktop/coding-plans/state" })
    return () => { alive.current = false; revision.current++; action.current = undefined }
  }, [active, run])

  const pending = state?.login?.status === "pending" || state?.openaiManagement?.status === "pending" || busy === "desktop/coding-plans/start"
  const pollInterval = pending ? 1500 : state?.accounts.some(account => account.status === "connected") ? 60_000 : undefined
  useEffect(() => {
    if (!active || busy || pollInterval === undefined) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const next = await run({ kind: "desktop/coding-plans/state" }, true)
      // State reads let the backend own usage freshness. They never redeem cards.
      if (!stopped && (!next || next.login?.status === "pending" || next.openaiManagement?.status === "pending" || next.accounts.some(account => account.status === "connected"))) timer = setTimeout(poll, pollInterval)
    }
    timer = setTimeout(poll, pollInterval)
    return () => { stopped = true; clearTimeout(timer) }
  }, [active, busy, pollInterval, run])

  const connectedAccount = state?.accounts.find(account => account.status === "connected")
  const management: OpenAiManagementState | undefined = state?.openaiManagement ?? (connectedAccount ? { status: "connected", accountId: connectedAccount.id } : undefined)
  const showUsage = management && state?.accounts.some(account => account.id === management.accountId)
  const dismiss = () => { void run({ kind: "desktop/coding-plans/welcome-dismiss" }) }
  return <div className="coding-plans">
    <label className="coding-plans-provider"><span>{t("訂閱提供商")}</span><select aria-label={t("訂閱提供商")} value="openai-codex" onChange={() => {}}><option value="openai-codex">OpenAI / Codex</option></select></label>
    <section className="coding-plans-card" aria-label={t("OpenAI / ChatGPT（Codex 訂閱）")}>
      <div className="coding-plans-header"><h2>{t("OpenAI / ChatGPT（Codex 訂閱）")}</h2></div>
      {!state?.accounts.length ? <div className="coding-plans-connect"><p>{t("登入 ChatGPT 帳號，在 I-harness 使用 Codex 訂閱模型。")}</p><Button variant="primary" disabled={!state || !!busy || pending} onClick={() => { void run({ kind: "desktop/coding-plans/start" }) }}>{t("使用 ChatGPT 繼續")}</Button></div> : null}
      {pending ? <div className="coding-plans-pending"><div><p role="status">{t("請在瀏覽器完成 Codex 訂閱授權。")}</p>{state?.openaiManagement?.login ? <DeviceCode key={state.openaiManagement.login.userCode} code={state.openaiManagement.login.userCode} /> : null}</div><Button size="small" disabled={busy === "desktop/coding-plans/cancel"} loading={busy === "desktop/coding-plans/cancel"} onClick={() => { void run({ kind: "desktop/coding-plans/cancel" }) }}>{t("取消登入")}</Button></div> : null}
      {state?.login?.status === "failed" ? <p role="alert">{state.login.message || t("登入未完成，請重試。")}</p> : null}
      {!state && !error ? <p role="status" className="muted">{t("正在讀取訂閱帳號…")}</p> : null}
      {state?.accounts.length === 0 && !pending ? <p className="coding-plans-empty">{t("尚未連接 ChatGPT 帳號。")}</p> : null}
      <div className="coding-plans-accounts">{state?.accounts.map(account => <AccountCard key={account.id} account={account} plan={management?.accountId === account.id ? management.plan : undefined} disabled={!!busy || pending} run={run} onManageModels={onManageModels} />)}</div>
      {showUsage ? <OpenAiManagement key={management.accountId} state={management} busy={busy} active={active} error={error} run={run} /> : null}
    </section>
    {state?.message ? <p role="status" className="coding-plans-feedback">{state.message}</p> : null}
    {error ? <div className="coding-plans-feedback" role="alert"><p>{error}</p>{!state ? <Button size="small" disabled={!!busy} onClick={() => { void run({ kind: "desktop/coding-plans/state" }) }}>{t("重試")}</Button> : null}</div> : null}
    {state?.welcomePending && state.accounts.some(account => account.status === "connected") ? <SettingsDialog active={active} title={t("已連接你的 Codex 訂閱")} closeLabel={t("關閉")} busy={!!busy} onClose={dismiss} initialFocusSelector=".coding-plans-welcome-confirm">
      <p>{t("在「模型與提供商」管理 Codex 模型；此頁顯示同一帳號的訂閱額度與重置卡。")}</p>
      {error ? <p role="alert">{error}</p> : null}<Button className="coding-plans-welcome-confirm" variant="primary" loading={!!busy} onClick={dismiss}>{t("知道了")}</Button>
    </SettingsDialog> : null}
  </div>
}

function DeviceCode({ code }: { code: string }) {
  const t = useText()
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed">()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(code)
      if (mounted.current) setCopyStatus("copied")
    } catch { if (mounted.current) setCopyStatus("failed") }
  }
  return <div className="coding-plans-device"><p>{t("請在已開啟的 OpenAI 驗證頁輸入以下代碼，完成 Codex 登入。")}</p><div className="coding-plans-device-code"><code>{code}</code><Button size="small" onClick={() => { void copy() }}>{t("複製驗證碼")}</Button>{copyStatus ? <span role="status">{copyStatus === "copied" ? t("驗證碼已複製") : t("無法複製，請手動選取驗證碼。")}</span> : null}</div></div>
}

function canRedeemCredit(credit?: NonNullable<OpenAiManagementState["credits"]>[number]): boolean {
  return credit?.status === "available" && credit.resetType === "codex_rate_limits" && (credit.expiresAt === undefined || credit.expiresAt > Date.now())
}

function UsageWindows({ windows, active }: { windows: NonNullable<OpenAiManagementState["windows"]>; active: boolean }) {
  const t = useText()
  const locale = useLocale(value => value.locale)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [active])
  const countdown = (resetsAt: number) => {
    const minutes = Math.ceil((resetsAt - now) / 60_000)
    if (minutes <= 0) return t("已到重置時間，等待更新")
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24
    if (days) return t("{days} 天 {hours} 小時後重置", { days, hours })
    if (hours) return t("{hours} 小時 {minutes} 分鐘後重置", { hours, minutes: minutes % 60 })
    return t("{minutes} 分鐘後重置", { minutes })
  }
  return <div className="coding-plans-windows">{windows.map((window, index) => {
    const separator = window.name.lastIndexOf(": ")
    const legacyScope = separator > 0 ? window.name.slice(0, separator).trim() : undefined
    const durationName = separator > 0 ? window.name.slice(separator + 2).trim() : window.name.trim()
    const fallbackName = durationName.toLowerCase().replace(/[-_]/g, " ")
    const durationLabel = window.limitSeconds === 604800 ? t("每週額度") : window.limitSeconds === 18000 ? t("5 小時額度")
      : window.limitSeconds === undefined && /^(7 days|weekly|weekly allowance)$/.test(fallbackName) ? t("每週額度")
      : window.limitSeconds === undefined && /^(5 hours|5 hour|five hour allowance)$/.test(fallbackName) ? t("5 小時額度") : undefined
    const scope = window.scopeName?.trim() || (durationLabel ? legacyScope : undefined)
    const name = scope ? `${scope} · ${durationLabel ?? durationName}` : durationLabel ?? window.name
    const remaining = Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 ? Math.round((100 - window.usedPercent) * 100) / 100 : undefined
    const resetDate = window.resetsAt !== undefined && Number.isFinite(window.resetsAt) ? new Date(window.resetsAt) : undefined
    const validReset = resetDate && !Number.isNaN(resetDate.getTime())
    return <div className="coding-plans-window" key={`${window.name}:${index}`}>
      <div className="coding-plans-window-heading"><h4>{name}</h4><strong>{remaining === undefined ? t("額度未知") : t("剩餘 {percent}%", { percent: remaining })}</strong></div>
      {remaining !== undefined ? <progress max={100} value={remaining} aria-label={t("剩餘額度：{name}", { name })} /> : null}
      <div className="coding-plans-window-reset">{validReset ? <><span>{countdown(resetDate.getTime())}</span><time dateTime={resetDate.toISOString()}>{resetDate.toLocaleString(locale === "en" ? "en-US" : "zh-TW", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></> : <span>{t("重置時間尚未提供")}</span>}</div>
    </div>
  })}</div>
}

function OpenAiManagement({ state, busy, active, error, run }: {
  state: OpenAiManagementState
  busy?: CodingPlansRequest["kind"]
  active: boolean
  error?: string
  run(input: CodingPlansRequest): Promise<CodingPlansState | undefined>
}) {
  const t = useText()
  const locale = useLocale(value => value.locale)
  const [confirm, setConfirm] = useState<{ accountId: string; creditId: string }>()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const date = (value?: number) => value !== undefined && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString(locale === "en" ? "en-US" : "zh-TW") : t("未提供")
  const credits = state.credits ?? []
  const pendingCredit = state.pendingRedemption?.creditId
  const selected = credits.find(credit => credit.id === confirm?.creditId)
  const sameAccount = !!confirm && confirm.accountId === state.accountId && state.status === "connected"
  const canConfirm = sameAccount && (pendingCredit ? pendingCredit === confirm?.creditId : canRedeemCredit(selected))
  const open = (creditId: string) => { if (state.accountId) setConfirm({ accountId: state.accountId, creditId }) }
  const redeem = async () => {
    if (!confirm || !canConfirm || busy || !pendingCredit && !canRedeemCredit(selected)) return
    const result = await run({ kind: "desktop/coding-plans/reset-credit", accountId: confirm.accountId, creditId: confirm.creditId, confirmed: true })
    if (result && mounted.current) setConfirm(undefined)
  }
  const creditStatus = (status: string) => status === "available" ? t("可使用") : status === "expired" ? t("已過期") : status === "redeemed" ? t("已兌換") : status
  const outcomes = { reset: t("已確認重置額度。"), nothing_to_reset: t("目前沒有需要重置的額度。"), no_credit: t("服務未提供可用的重置卡。"), already_redeemed: t("此重置卡已兌換。"), unknown: t("重置結果未知；請重試同一張卡以確認結果，暫勿使用其他卡。") }
  return <section className="coding-plans-management" aria-label={t("Codex 訂閱額度與重置卡")}>
    <div className="coding-plans-limits-header"><h3>{t("方案限制")}</h3><Button size="small" variant="ghost" icon={<RefreshCw size={13} />} aria-label={t("更新額度與重置卡")} disabled={!!busy || state.status !== "connected"} onClick={() => { void run({ kind: "desktop/coding-plans/management-refresh" }) }}>{t("重新整理")}</Button></div>
    {state.status === "connected" ? <>
      {state.windows?.length ? <UsageWindows windows={state.windows} active={active} /> : <p>{t("尚未取得額度視窗。")}</p>}
      {state.creditBalance?.unlimited === true ? <p className="coding-plans-balance">{t("可用點數：無上限")}</p> : typeof state.creditBalance?.balance === "string" && state.creditBalance.balance.trim() ? <p className="coding-plans-balance">{t("可用點數：{balance}", { balance: state.creditBalance.balance })}</p> : null}
      <div className="coding-plans-credit-heading"><h3>{t("重置卡")}</h3><span>{state.availableCount !== undefined && Number.isFinite(state.availableCount) && state.availableCount >= 0 ? t("可用重置卡：{count}", { count: state.availableCount }) : t("可用重置卡：未知")}</span></div>
      {state.pendingRedemption ? <div className="coding-plans-feedback"><p role="status">{t("重置結果未知；請重試同一張卡以確認結果，暫勿使用其他卡。")}</p><code>{state.pendingRedemption.creditId}</code>{!credits.some(credit => credit.id === pendingCredit) ? <Button size="small" disabled={!!busy || !state.accountId} onClick={() => open(state.pendingRedemption!.creditId)}>{t("重試此卡")}</Button> : null}</div> : null}
      <div className="coding-plans-credits">{credits.map(credit => <article key={credit.id} className="coding-plans-credit"><div><h4>{credit.title || (credit.resetType === "codex_rate_limits" ? t("Codex 額度") : t("尚未支援的重置類型"))}</h4><p>{credit.resetType !== "codex_rate_limits" && credit.status === "available" ? t("I-harness 尚無法使用") : creditStatus(credit.status)} · {t("到期時間：{date}", { date: date(credit.expiresAt) })}</p></div>{credit.status === "available" || credit.id === pendingCredit ? <Button size="small" disabled={!!busy || !state.accountId || (pendingCredit ? pendingCredit !== credit.id : !canRedeemCredit(credit))} onClick={() => open(credit.id)}>{credit.id === pendingCredit ? t("重試此卡") : t("使用重置卡")}</Button> : null}</article>)}</div>
    </> : null}
    {state.outcome && !(state.outcome === "unknown" && state.pendingRedemption) ? <p role="status">{outcomes[state.outcome]}</p> : null}{state.message ? <p role="status">{state.message}</p> : null}
    {confirm ? <SettingsDialog title={t("確認使用重置卡")} closeLabel={t("取消")} active={active} busy={!!busy} onClose={() => setConfirm(undefined)} initialFocusSelector=".coding-plans-reset-cancel"><p>{t("確認後會向 OpenAI 要求使用此卡重置 Codex 訂閱額度。請確認目前已登入的帳號與卡片。")}</p><dl className="coding-plans-confirm-details"><dt>{t("Codex 帳號")}</dt><dd>{state.email || confirm.accountId}</dd>{state.email ? <dd>{confirm.accountId}</dd> : null}<dt>{t("重置卡")}</dt>{selected?.title ? <dd>{selected.title}</dd> : null}<dd>{confirm.creditId}</dd><dt>{t("到期時間")}</dt><dd>{date(selected?.expiresAt)}</dd></dl>{!canConfirm ? <p role="alert">{t("帳號或卡片狀態已變更，請關閉並更新資料。")}</p> : null}{error ? <p role="alert">{error}</p> : null}<div className="coding-plans-account-actions"><Button className="coding-plans-reset-cancel" disabled={!!busy} onClick={() => setConfirm(undefined)}>{t("取消")}</Button><Button variant="primary" disabled={!canConfirm || !!busy} loading={busy === "desktop/coding-plans/reset-credit"} onClick={() => { void redeem() }}>{t("確認並使用卡片")}</Button></div></SettingsDialog> : null}
  </section>
}

function AccountCard({ account, plan, disabled, run, onManageModels }: { account: CodingPlanAccount; plan?: string; disabled: boolean; run(input: CodingPlansRequest): Promise<unknown>; onManageModels?(): void }) {
  const t = useText()
  const status = account.status === "connected" ? t("訂閱已授權") : account.status === "identity-only" ? t("僅驗證身分") : t("需要重新授權")
  const identity = account.label || account.email || t("ChatGPT 帳號")
  const planName = plan && /^(pro|plus|free|team|business|enterprise|edu)$/i.test(plan) ? `ChatGPT ${plan[0]!.toUpperCase()}${plan.slice(1).toLowerCase()}` : plan
  return <article className="coding-plans-account" aria-label={account.email || identity}>
    <div className="coding-plans-account-header"><span className="coding-plans-avatar"><UserRound size={18} aria-hidden="true" /></span><div className="coding-plans-identity"><h3>{identity}</h3>{account.email && account.email !== identity ? <p>{account.email}</p> : null}<span className="coding-plans-status" data-connected={account.status === "connected"}>{account.status === "connected" ? <Check size={12} aria-hidden="true" /> : null}{status}</span></div>{planName ? <span className="coding-plans-route">{planName}</span> : null}</div>
    {account.status !== "connected" ? <p>{account.status === "identity-only" ? t("此帳號已登入，但尚未授權訂閱模型使用。") : t("此帳號的授權需要更新，請重新登入。")}</p> : null}
    <div className="coding-plans-account-actions">{onManageModels ? <Button size="small" onClick={onManageModels}>{t("管理模型")}</Button> : null}<Button size="small" variant="ghost" disabled={disabled} onClick={() => { void run({ kind: "desktop/coding-plans/start", accountId: account.id }) }}>{account.status === "identity-only" ? t("授權訂閱使用") : t("重新登入")}</Button><Button size="small" variant="ghost" disabled={disabled} onClick={() => { void run({ kind: "desktop/coding-plans/signout", accountId: account.id }) }}>{t("登出")}</Button></div>
  </article>
}
