import { useId, useLayoutEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowUpRight, PanelRightOpen } from "lucide-react"
import { createPortal } from "react-dom"
import type { SessionContextState } from "@i-harness/sdk/context"
import type { SessionModelState } from "@i-harness/sdk"
import { contextOccupancy } from "./context-occupancy.ts"
import { useSessionContext } from "./use-session-context.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale, useText, type Message } from "../design/i18n.ts"
import { listenForegroundEscape } from "../design/foreground-escape.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import "./ContextUsage.css"

const hoverCloseDelay = 120
type PopupState = { bridge: DesktopBridge; workspaceId: string; sessionId: string; mode: "hover" | "explicit" }
const unavailableMessages: Record<string, Message> = {
  "Conversation history changed since the last prepared budget": "會話內容已重整，等待下一次請求的容量估算。",
  "Model context binding changed since the last prepared budget": "模型設定已變更，等待下一次請求的容量估算。",
  "No saved prepared budget is available": "尚未準備模型請求，暫無上下文估算。",
  "No conversation request budget is available": "尚未準備模型請求，暫無上下文估算。",
  "Accepted output awaits the next protocol projection": "模型已回覆；下一次請求準備完成後會重新估算容量。",
  "No prepared request budget is available": "尚未準備模型請求，暫無上下文估算。",
  "Provider context recovery remains required": "供應商拒絕了目前上下文，需先壓縮或更換模型。",
  "Prepared admission is historical": "顯示上一次請求的估算；下一次請求準備完成後會更新。",
  "Model-visible history changed since the prepared budget": "上下文內容已變更；下一次請求準備完成後會更新估算。",
  "Projection revision changed since the prepared budget": "上下文內容已變更；下一次請求準備完成後會更新估算。",
  "Model request surface changed since the prepared budget": "上下文內容已變更；下一次請求準備完成後會更新估算。",
  "Model configuration identity changed since the prepared budget": "模型設定已變更，等待下一次請求的容量估算。",
  "Concrete model binding changed since the prepared budget": "模型設定已變更，等待下一次請求的容量估算。",
  "Model context binding changed": "模型設定已變更，等待下一次請求的容量估算。",
  "Inherited model binding changed before the next logical step": "模型設定已變更，等待下一次請求的容量估算。",
  "This model has no configured context window": "此模型沒有可用的上下文容量資料。",
  "Prepared input includes unpriced fixed provider references": "部分供應商端內容無法估算，暫時不能確認可用容量。",
  "capacity-unknown": "目前無法確認此請求的容量限制。",
  "capacity-conflict": "模型設定的容量限制不一致。",
  "input-overflow": "估算輸入已超過可用輸入預算。",
  "body-overflow": "請求內容超過供應商的傳輸大小限制。",
  "output-floor": "剩餘容量不足以保留最低輸出額度。",
  "output-ceiling": "請求需要的輸出額度超過模型限制。",
  "strict-capacity-required": "此操作需要可驗證的模型容量限制。",
  "Context compaction is required": "需要先壓縮上下文才能繼續請求。",
}
const sourceLabels = { "projected-heuristic": "已準備輸入的估算", "provider-anchor-plus-projection": "供應商用量加上新增輸入", "neutral-only": "通用格式估算" } as const
const confidenceLabels = { estimated: "估算值", "calibrated-mixed": "部分依用量校準", "unknown-components": "部分內容成本不確定" } as const
const coverageLabels = { complete: "已包含完整輸入", "neutral-only": "僅包含通用格式", incomplete: "輸入估算不完整" } as const
const capLabels = { supported: "支援，未記錄上限數值", unsupported: "此路由不支援", unknown: "是否套用尚不確定" } as const
const number = new Intl.NumberFormat("en-US").format

function outputCapText(t: ReturnType<typeof useText>, support: keyof typeof capLabels, cap?: number) {
  return support === "supported" && cap !== undefined ? `${t("已套用")} · ${number(cap)}` : t(capLabels[support])
}

function admissionReason(state: Extract<SessionContextState, { kind: "unavailable" }>): string {
  const { observation } = state
  if (observation?.fullByProvider || state.snapshot?.fullByProvider) return "Provider context recovery remains required"
  if (observation?.recoveryRequired || state.snapshot?.recoveryRequired) return "Context compaction is required"
  if (observation?.reason && (state.reason === "Prepared admission is historical" || state.reason === "Capacity is unchecked or requires reduction")) return observation.reason
  if (observation?.disposition === "reduce" || state.snapshot?.admission === "compact") return "Context compaction is required"
  return state.reason
}

type ContextUsageScope = { bridge: DesktopBridge; workspaceId: string; sessionId: string }
type ContextViews = { usage: ReturnType<typeof useSessionContext>; modelState?: SessionModelState }

export function ContextUsage({ refreshKey, modelState, ...scope }: ContextUsageScope & { refreshKey?: string; modelState?: SessionModelState }) {
  const usage = useSessionContext(scope.bridge, scope.workspaceId, scope.sessionId, refreshKey)
  return <ContextUsageTrigger {...scope} usage={usage} modelState={modelState} />
}

function useContextReading({ usage, modelState }: ContextViews) {
  const t = useText()
  const { current } = usage
  const state = current?.state
  const error = current?.error
  const observation = state?.observation
  const { estimate: preparedEstimate, legacyReady, historical: stale, modelChanged, modelWindow, inputBudget,
    measured, tokens, denominator, percent, reading, warning } = contextOccupancy(state, modelState)
  const snapshot = state?.snapshot
  const basis = modelWindow !== undefined ? t(measured !== undefined ? "上次實測輸入 / 模型上下文視窗" : "估算輸入 / 模型上下文視窗")
    : inputBudget !== undefined ? t(measured !== undefined ? "上次實測輸入 / 可用輸入預算" : "估算輸入 / 可用輸入預算") : undefined
  const sourceLabel = measured !== undefined ? t("上次請求輸入（供應商回報）") : stale ? t("上次請求估算") : t("本次請求估算")
  const binding = observation ?? snapshot
  const model = binding?.providerId ? `${binding.providerId} / ${binding.modelId}` : binding?.modelId
  const reason = state?.kind === "unavailable" ? admissionReason(state) : undefined
  const historicalReading = stale && tokens !== undefined && !warning
  const canRetry = error !== undefined || state?.kind === "unavailable" && !historicalReading
  const status = modelChanged ? t("模型設定已變更，等待下一次請求的容量估算。") : reason === "capacity-unknown" && modelWindow !== undefined && inputBudget === undefined
    ? t("可用輸入預算尚未確認。")
    : historicalReading && reason === "Prepared admission is historical" ? undefined
    : reason && Object.hasOwn(unavailableMessages, reason) ? t(unavailableMessages[reason]) : reason
  const readingDetail = [percent === undefined ? undefined : basis, !modelChanged && stale ? sourceLabel : undefined, warning || modelChanged ? status : undefined].filter(Boolean).join(" · ")
  const systemTokens = snapshot?.systemTokens ?? 0
  const toolTokens = snapshot?.schemaTokens ?? 0
  const messageTokens = snapshot ? snapshot.roleTokens.user + snapshot.roleTokens.assistant + snapshot.roleTokens.tool : 0
  const breakdownTotal = systemTokens + toolTokens + messageTokens || 1
  const capacity = tokens === undefined ? undefined : denominator === undefined
    ? t("{count} Token", { count: number(tokens) }) : `${number(tokens)} / ${number(denominator)} (${reading})`

  return { state, error, observation, snapshot, preparedEstimate, legacyReady, modelChanged, modelWindow, inputBudget,
    measured, tokens, denominator, percent, reading, warning, basis, sourceLabel, model, canRetry, status, readingDetail,
    systemTokens, toolTokens, messageTokens, breakdownTotal, capacity }
}

type Reading = ReturnType<typeof useContextReading>

function ContextFacts({ view, usage, layout = "popover" }: { view: Reading; usage: ContextViews["usage"]; layout?: "popover" | "sidebar" | "page" }) {
  const t = useText()
  const { current, retry } = usage
  const { state, error, observation, snapshot, preparedEstimate, legacyReady, modelChanged, modelWindow, inputBudget,
    measured, tokens, denominator, percent, warning, basis, sourceLabel, model, canRetry, status,
    systemTokens, toolTokens, messageTokens, breakdownTotal, capacity } = view
  return <>
    {capacity !== undefined ? <>
      {observation ? <small className="muted">{sourceLabel}</small> : null}
      <p className="context-usage-capacity">{capacity}</p>
      {basis ? <small className="muted">{basis}</small> : null}
      {snapshot && legacyReady ? <div className="context-usage-breakdown" aria-label={t("訊息來源")}>
        <div className="context-usage-stack" aria-hidden="true">
          {([['system', systemTokens], ['tools', toolTokens], ['messages', messageTokens]] as const).map(([key, tokens]) =>
            <span key={key} className={`context-usage-segment context-usage-segment-${key}`} style={{ width: `${Math.min(percent ?? 0, 100) * tokens / breakdownTotal}%` }} />)}
        </div>
      </div> : denominator !== undefined && tokens !== undefined
        ? <progress max={denominator} value={Math.min(tokens, denominator)} aria-label={basis ?? t("估算已用 Token")} /> : null}
      {inputBudget !== undefined && inputBudget !== denominator ? <dl className="context-usage-remaining">
        <div className="context-usage-fact"><dt>{t("可用輸入預算")}</dt><dd>{t("{count} Token", { count: number(inputBudget) })}</dd></div>
      </dl> : null}
      {legacyReady && snapshot?.remainingInputBudget !== undefined ? <dl className="context-usage-remaining">
        <div className="context-usage-fact"><dt>{t("剩餘輸入預算")}</dt><dd>{number(snapshot.remainingInputBudget)}</dd></div>
      </dl> : null}
      {legacyReady ? <small>{t(snapshot ? "根據已準備的供應商輸入估算，包含系統提示與工具定義；與帳單和快取計數分開。" : "根據目前可見的模型訊息估算；不是供應商帳單或快取命中率。")}</small> : null}
    </> : !state && error === undefined ? <p>{t("讀取上下文容量中…")}</p> : null}
    {model !== undefined ? <dl className="context-usage-fact-group">
      <div className="context-usage-fact"><dt>{t(modelChanged ? "上次請求的模型" : "模型")}</dt><dd>{model}</dd></div>
      {(measured !== undefined || modelChanged) && preparedEstimate ? <div className="context-usage-fact"><dt>{t("上次估算輸入")}</dt><dd>~{number(preparedEstimate.value)}</dd></div> : null}
      {modelWindow !== undefined && tokens === undefined ? <div className="context-usage-fact"><dt>{t("模型上下文視窗")}</dt><dd>{t("{count} Token", { count: number(modelWindow) })}</dd></div> : null}
      {!modelChanged && measured === undefined && state?.lastReportedInputTokens !== undefined ? <div className="context-usage-fact"><dt>{t("上次請求輸入（供應商回報）")}</dt><dd>{t("{count} Token", { count: number(state.lastReportedInputTokens) })}</dd></div> : null}
    </dl> : null}
    {status || canRetry ? <div>
      <p className={warning ? "context-usage-warning" : undefined} role={error !== undefined ? "alert" : undefined}>{error || status || t("無法取得上下文容量。")}</p>
      {canRetry ? <Button variant="secondary" size="small" loading={current?.loading} loadingLabel={t("正在處理…")} onClick={retry}>{t("刷新狀態")}</Button> : null}
    </div> : null}
    {layout !== "sidebar" && observation && preparedEstimate ? <div className="context-usage-facts" aria-label={t("已準備的上下文")}>
      <small>{t(measured !== undefined ? "上次請求的分項估算" : sourceLabels[preparedEstimate.source])}</small>
      <dl className="context-usage-fact-group" aria-label={t("輸入分項估算")}>
        <div className="context-usage-fact"><dt>{t("系統提示")}</dt><dd>~{number(observation.components.system)}</dd></div>
        <div className="context-usage-fact"><dt>{t("工具定義")}</dt><dd>~{number(observation.components.schema)}</dd></div>
        {layout === "page" ? <>
          <div className="context-usage-fact"><dt>{t("使用者訊息")}</dt><dd>~{number(observation.components.user)}</dd></div>
          <div className="context-usage-fact"><dt>{t("助手訊息")}</dt><dd>~{number(observation.components.assistant)}</dd></div>
          <div className="context-usage-fact"><dt>{t("工具訊息")}</dt><dd>~{number(observation.components.tool)}</dd></div>
        </> : <div className="context-usage-fact"><dt>{t("訊息")}</dt><dd>~{number(observation.components.user + observation.components.assistant + observation.components.tool)}</dd></div>}
        {observation.components.reasoning > 0 ? <div className="context-usage-fact"><dt>{t("其中重用推理")}</dt><dd>~{number(observation.components.reasoning)}</dd></div> : null}
      </dl>
      {measured !== undefined ? <small>{t("分項依內容估算，合計可能與供應商實測的總數不同。")}</small>
        : preparedEstimate.source === "provider-anchor-plus-projection" ? <small>{t("分項由內容估算，合計可能與校準後的總數不同。")}</small> : null}
    </div> : null}
    {layout !== "sidebar" && snapshot ? <div className="context-usage-facts" aria-label={t("已準備的上下文")}>
      <small>{t(sourceLabels[snapshot.estimateSource])} · {t(confidenceLabels[snapshot.confidence])} · {t(coverageLabels[snapshot.coverage])}</small>
      <dl className="context-usage-fact-group">
        <div className="context-usage-fact"><dt>{t("系統提示")}</dt><dd>{legacyReady ? "~" : ""}{number(systemTokens)}</dd></div>
        <div className="context-usage-fact"><dt>{t("工具定義")}</dt><dd>{legacyReady ? "~" : ""}{number(toolTokens)}</dd></div>
        {legacyReady ? <div className="context-usage-fact"><dt>{t("訊息")}</dt><dd>~{number(messageTokens)}</dd></div> : null}
        <div className="context-usage-fact"><dt>{t("重用推理")}</dt><dd>{number(snapshot.reasoningTokens)}</dd></div>
        {!legacyReady ? <div className="context-usage-fact"><dt>{t("上次估算輸入")}</dt><dd>{number(snapshot.estimatedInputTokens)}</dd></div> : null}
      </dl>
      <dl className="context-usage-fact-group">
        <div className="context-usage-fact"><dt>{t("輸出預留")}</dt><dd>{number(snapshot.outputReserve)}</dd></div>
        <div className="context-usage-fact"><dt>{t("輸出上限")}</dt><dd>{outputCapText(t, snapshot.capSupport, snapshot.effectiveOutputCap)}</dd></div>
        <div className="context-usage-fact"><dt>{t("安全餘量")}</dt><dd>{number(snapshot.safetyMargin)}</dd></div>
      </dl>
      {snapshot.capSupport === "unsupported" ? <small>{t("此路由未套用傳送給供應商的輸出上限。")}</small> : null}
      {legacyReady && snapshot.admission === "compact" ? <p>{t("需要先壓縮上下文才能繼續請求。")}</p> : null}
    </div> : null}
  </>
}

export function ContextUsageSidebar(props: ContextViews & { onOpenPage(): void }) {
  const t = useText()
  const view = useContextReading(props)
  return <section className="context-summary-pane" aria-label={t("上下文摘要")}>
    <h2>{t("上下文摘要")}</h2>
    <ContextFacts view={view} usage={props.usage} layout="sidebar" />
    <Button variant="secondary" size="small" data-context-open-page onClick={props.onOpenPage}><ArrowUpRight aria-hidden="true" size={14} />{t("查看完整上下文")}</Button>
  </section>
}

export function ContextUsagePage(props: ContextViews & { onBack(): void; sessionTitle?: string; turnCount?: number; updatedAt?: number }) {
  const t = useText()
  const locale = useLocale(state => state.locale)
  const view = useContextReading(props)
  const observation = view.observation
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  const lastActivity = props.updatedAt === undefined ? undefined : new Date(props.updatedAt)
  const hasDate = lastActivity !== undefined && Number.isFinite(lastActivity.valueOf())
  return <section className="session-context-page" aria-label={t("上下文詳情")}>
    <div className="session-context-content">
      <Button variant="ghost" size="small" onClick={props.onBack}><ArrowLeft aria-hidden="true" size={14} />{t("返回會話")}</Button>
      <header>
        <h1 ref={heading} tabIndex={-1}>{t("上下文詳情")}</h1>
        {props.sessionTitle ? <p>{props.sessionTitle}</p> : null}
        {props.turnCount !== undefined || hasDate ? <dl className="context-session-metadata">
          {props.turnCount !== undefined ? <div><dt>{t("回合數")}</dt><dd>{props.turnCount.toLocaleString(locale)}</dd></div> : null}
          {hasDate ? <div><dt>{t("最後活動")}</dt><dd><time dateTime={lastActivity.toISOString()}>{lastActivity.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}</time></dd></div> : null}
        </dl> : null}
      </header>
      <section className="session-context-section" aria-label={t("上下文容量")}>
        <h2>{t("上下文容量")}</h2>
        <ContextFacts view={view} usage={props.usage} layout="page" />
      </section>
      {observation && !view.modelChanged ? <section className="session-context-section" aria-label={t("請求限制")}>
        <h2>{t("請求限制")}</h2>
        <dl className="context-usage-fact-group">
          {view.modelWindow !== undefined ? <div className="context-usage-fact"><dt>{t("模型上下文視窗")}</dt><dd>{number(view.modelWindow)}</dd></div> : null}
          <div className="context-usage-fact"><dt>{t("輸出上限")}</dt><dd>{outputCapText(t, observation.output.capSupport, observation.output.effectiveCap)}</dd></div>
          {observation.output.allowance !== undefined ? <div className="context-usage-fact"><dt>{t("輸出預留")}</dt><dd>{number(observation.output.allowance)}</dd></div> : null}
        </dl>
      </section> : null}
    </div>
  </section>
}

export function ContextUsageTrigger({ bridge, workspaceId, sessionId, usage, modelState, onOpenSidebar }: ContextUsageScope & ContextViews & { onOpenSidebar?(): void }) {
  const t = useText()
  const panelId = useId()
  const readingId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [popup, setPopup] = useState<PopupState>()
  const open = popup?.bridge === bridge && popup.workspaceId === workspaceId && popup.sessionId === sessionId
  const mode = open ? popup.mode : undefined
  const [placement, setPlacement] = useState({ right: 24, bottom: 72 })
  function cancelClose() { clearTimeout(closeTimer.current); closeTimer.current = undefined }
  function closePopup(returnFocus = false) {
    cancelClose()
    const focused = document.activeElement
    if (returnFocus && (panel.current?.contains(focused) || mode === "explicit" && focused === document.body)) trigger.current?.focus()
    setPopup(undefined)
  }
  function preview() {
    cancelClose()
    setPopup(previous => previous?.bridge === bridge && previous.workspaceId === workspaceId && previous.sessionId === sessionId
      ? previous : { bridge, workspaceId, sessionId, mode: "hover" })
  }
  function scheduleClose() {
    if (!open) return
    cancelClose()
    closeTimer.current = setTimeout(() => closePopup(true), hoverCloseDelay)
  }
  function activate() {
    cancelClose()
    if (open && mode === "explicit") closePopup(true)
    else setPopup({ bridge, workspaceId, sessionId, mode: "explicit" })
  }
  useLayoutEffect(() => {
    cancelClose()
    setPopup(undefined)
    return cancelClose
  }, [bridge, workspaceId, sessionId])
  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect && panel.current) {
        const maxRight = window.innerWidth - panel.current.getBoundingClientRect().width - 16
        setPlacement({ right: Math.max(16, Math.min(maxRight, window.innerWidth - rect.right)), bottom: Math.max(16, window.innerHeight - rect.top + 10) })
      }
    }
    position()
    if (mode === "explicit") panel.current?.focus()
    window.addEventListener("resize", position)
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) closePopup() }
    const removeEscape = listenForegroundEscape(panel.current, () => { closePopup(true); if (mode === "explicit") trigger.current?.focus() })
    document.addEventListener("pointerdown", dismiss)
    return () => { window.removeEventListener("resize", position); document.removeEventListener("pointerdown", dismiss); removeEscape() }
  }, [open, mode])
  const view = useContextReading({ usage, modelState })
  const { reading, readingDetail, warning, percent } = view
  const detailId = `${readingId}-details`

  return <>
    <button ref={trigger} type="button" className={warning ? "icon-button context-usage-trigger context-usage-trigger-warning" : "icon-button context-usage-trigger"} aria-label={t("上下文容量")} aria-describedby={readingDetail ? `${readingId} ${detailId}` : readingId} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} title={open ? undefined : `${t("上下文容量")} · ${reading}${readingDetail ? ` · ${readingDetail}` : ""}`} onClick={activate}
      onMouseEnter={preview} onMouseLeave={scheduleClose} onPointerEnter={event => { if (event.pointerType !== "touch") preview() }} onPointerLeave={event => { if (event.pointerType !== "touch") scheduleClose() }}>
      <svg className="context-usage-gauge" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle className="context-usage-gauge-track" cx="8" cy="8" r="6" />
        {percent !== undefined && percent > 0 ? <circle className="context-usage-gauge-fill" cx="8" cy="8" r="6" pathLength="100" strokeDasharray={`${Math.min(percent, 100)} 100`} transform="rotate(-90 8 8)" /> : null}
      </svg>
      <span id={readingId} className="context-usage-reading">{reading}</span>
    </button>
    {readingDetail ? <span id={detailId} hidden>{readingDetail}</span> : null}
    {open ? createPortal(<div id={panelId} ref={panel} tabIndex={-1} className="context-usage-popover ih-menu-surface" style={{ ...placement, maxHeight: `calc(100vh - ${placement.bottom + 16}px)` }} role="dialog" aria-label={t("上下文容量")}
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose} onPointerEnter={cancelClose} onPointerLeave={event => { if (event.pointerType !== "touch") scheduleClose() }}>
      <strong>{t("上下文容量")}</strong>
      <ContextFacts view={view} usage={usage} />
      {onOpenSidebar ? <Button variant="secondary" size="small" className="context-open-sidebar" onClick={() => { closePopup(); onOpenSidebar() }}>
        <PanelRightOpen aria-hidden="true" size={14} />{t("在側邊欄查看上下文")}
      </Button> : null}
    </div>, document.body) : null}
  </>
}
