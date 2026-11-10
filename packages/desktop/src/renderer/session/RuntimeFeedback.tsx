import { useEffect, useRef, useState } from "react"
import { AlertCircle, LoaderCircle, X } from "lucide-react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { RuntimeActivity, RuntimeDiagnosticEntry } from "../../shared/runtime-diagnostics.ts"
import { useText } from "../design/i18n.ts"
import { displayError } from "../design/error-display.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { RuntimeDetails } from "../settings/RuntimeLog.tsx"
import "./RuntimeFeedback.css"
import { useUiStore } from "../shell/ui-store.ts"

interface Feedback { retry?: RuntimeDiagnosticEntry; error?: RuntimeDiagnosticEntry; activity?: RuntimeActivity["activity"] }
const scopeKey = (workspaceId?: string, sessionId?: string) => JSON.stringify([workspaceId, sessionId])
const feedbackKinds = new Set<RuntimeDiagnosticEntry["kind"]>([
  "model/retry", "model/recovered", "session/cancelled", "session/error", "runtime/error", "gateway/disconnected",
])

/** Live feedback only. Historical records remain in the native Log and never
 * resurrect popups after dismissal or a renderer restart. */
export function RuntimeFeedback({ bridge, workspaceId, sessionId, onOpenLog }: {
  bridge: DesktopBridge; workspaceId?: string; sessionId?: string; onOpenLog(): void
}) {
  const t = useText()
  const draftScope = useUiStore(state => state.draftSubmissionScope)
  const activeSessionId = sessionId ?? (draftScope && draftScope.workspaceId === workspaceId ? draftScope.sessionId : undefined)
  const [scopes, setScopes] = useState<Map<string, Feedback>>(() => new Map())
  const [details, setDetails] = useState<RuntimeDiagnosticEntry>()
  const seen = useRef(new Set<string>())
  const selectedScope = useRef(scopeKey(workspaceId, activeSessionId))
  selectedScope.current = scopeKey(workspaceId, activeSessionId)
  const executionStates = useRef(new Map<string, { revision: number; busy: boolean }>())
  const [now, setNow] = useState(Date.now)
  const [recovering,setRecovering]=useState(false)
  const [recoveryFailed,setRecoveryFailed]=useState(false)
  const recoveryFlight=useRef<object|undefined>(undefined)
  // D-01: a reload-time projection check names its session; only that session
  // shows the warning, and it is dismissed/cleared locally (never persisted).
  const [projection, setProjection] = useState<{ id: string; issues: string[] }>()
  useEffect(() => {
    setScopes(previous => new Map([...previous].map(([key, value]) => [key, { ...value, activity: undefined }])))
    setProjection(undefined)
  }, [workspaceId, activeSessionId])
  useEffect(() => {
    seen.current.clear(); executionStates.current.clear(); setScopes(new Map()); setDetails(undefined)
    return bridge.onEvent(event => {
      if (event.kind === "runtime/activity") {
        if (scopeKey(event.workspaceId, event.sessionId) !== selectedScope.current) return
        setScopes(previous => {
          const next = new Map(previous), key = scopeKey(event.workspaceId, event.sessionId)
          const current = next.get(key) ?? {}
          const activity = event.activity
          if (activity.phase === "connecting") next.set(key, { ...current, activity })
          else if (current.activity?.requestId === activity.requestId) next.set(key, { ...current, activity: activity.phase === "settled" ? undefined : activity })
          if (next.size > 100) next.delete(next.keys().next().value!)
          return next
        })
        return
      }
      if (event.kind === "sdk/ready") {
        // A successful reconnect supersedes the failure that took the gateway
        // down; the native log keeps the historical diagnostic.
        setScopes(previous => {
          const next = new Map(previous)
          for (const [key, current] of next) if (JSON.parse(key)[0] === event.workspaceId && current.error?.kind === "gateway/disconnected") next.set(key, { ...current, error: undefined })
          return next
        })
        return
      }
      if (event.kind === "sdk/disconnected") {
        for (const key of executionStates.current.keys()) if (JSON.parse(key)[0] === event.workspaceId) executionStates.current.delete(key)
        setScopes(previous => {
          const next = new Map(previous)
          for (const [key, current] of next) if (JSON.parse(key)[0] === event.workspaceId) next.set(key, { ...current, activity: undefined, retry: undefined })
          return next
        })
        return
      }
      if (event.kind === "runtime/diagnostic") {
        const entry = event.entry
        // Diagnostic bookkeeping belongs in the Log. Only explicit feedback
        // events may change retries or create a request-failure notification.
        if (!feedbackKinds.has(entry.kind)) return
        if (seen.current.has(entry.id)) return
        seen.current.add(entry.id)
        if (seen.current.size > 1000) seen.current.delete(seen.current.values().next().value!)
        // Capture authority at delivery time, before React can defer this
        // update past a later execution-state notification. Uncorrelated old
        // workflow failures remain visible without settling current feedback.
        const busy = entry.executionUncorrelated === true || executionStates.current.get(scopeKey(entry.workspaceId, entry.sessionId))?.busy === true
        setScopes(previous => {
          const next = new Map(previous), key = scopeKey(entry.workspaceId, entry.sessionId)
          const current = next.get(key) ?? {}
          if (entry.kind === "model/retry") next.set(key, { ...current, retry: entry })
          else if (entry.kind === "model/recovered") {
            if (!entry.requestId || current.retry?.requestId === entry.requestId) next.set(key, { ...current, retry: undefined })
          } else if (entry.kind === "session/cancelled") {
            if (!busy && (!entry.requestId || !current.retry || current.retry.requestId === entry.requestId)) next.set(key, { ...current, retry: undefined, activity: undefined })
          } else {
            // Admission failures belong to a separate RPC even in the same chat.
            const clearsRetry = !busy && entry.kind === "session/error" && (!entry.requestId || !current.retry || current.retry.requestId === entry.requestId)
            next.set(key, { ...current, retry: clearsRetry ? undefined : current.retry, activity: entry.kind === "session/error" && clearsRetry ? undefined : current.activity, error: entry })
            if (entry.kind === "gateway/disconnected") for (const [otherKey, value] of next) {
              if (JSON.parse(otherKey)[0] === entry.workspaceId) next.set(otherKey, { ...value, retry: undefined, activity: undefined })
            }
          }
          // UI state is ephemeral and bounded; native records own persistence.
          if (next.size > 100) next.delete(next.keys().next().value!)
          return next
        })
        return
      }
      if (event.kind === "sdk/notification" && event.method === "desktop/tasks/projection") {
        const params = event.params as { sessionId?: unknown; issues?: unknown } | null
        if (!params || typeof params.sessionId !== "string" || sessionId === undefined || params.sessionId !== sessionId) return
        if (!Array.isArray(params.issues) || params.issues.length === 0) return
        const issues = params.issues.filter((value): value is string => value === "terminal-without-turn-end" || value === "missing-child-session")
        if (issues.length === 0) return
        setProjection({ id: `${params.sessionId}:${issues.join(",")}`, issues })
        return
      }
      if (event.kind !== "sdk/notification" || (event.method !== "session/status" && event.method !== "session/event" && event.method !== "session/execution-state")) return
      const params = event.params as { sessionId?: unknown; status?: unknown; event?: { type?: unknown; text?: unknown; delta?: unknown } } | null
      if (!params || typeof params.sessionId !== "string") return
      const start = event.method === "session/event" && params.event?.type === "turn/start"
      const key = scopeKey(event.workspaceId, params.sessionId)
      const done = event.method === "session/status" && !executionStates.current.get(key)?.busy && ["completed", "cancelled", "canceled"].includes(String(params.status))
      let settled = false
      if (event.method === "session/execution-state") {
        const state = params as { running?: unknown; queued?: unknown; revision?: unknown }
        if (typeof state.running !== "boolean" || typeof state.queued !== "number" || !Number.isSafeInteger(state.queued) || state.queued < 0
          || typeof state.revision !== "number" || !Number.isSafeInteger(state.revision) || state.revision < 1) return
        if (state.revision <= (executionStates.current.get(key)?.revision ?? 0)) return
        executionStates.current.set(key, { revision: state.revision, busy: state.running || state.queued > 0 })
        if (executionStates.current.size > 2000) executionStates.current.delete(executionStates.current.keys().next().value!)
        settled = state.running === false && state.queued === 0
      }
      // Retried requests emit a native model/recovered entry on actual output.
      // Running/queued status is deliberately not a recovery signal.
      if (!start && !done && !settled) return
      setScopes(previous => {
        const next = new Map(previous), key = scopeKey(event.workspaceId, params.sessionId as string)
        const current = next.get(key)
        if (start) { next.delete(key); next.delete(scopeKey(event.workspaceId)) }
        else if (current) next.set(key, { ...current, retry: undefined, activity: undefined })
        return next
      })
    })
  }, [bridge])
  const selected = scopes.get(scopeKey(workspaceId, activeSessionId))
  const global = scopes.get(scopeKey(workspaceId))
  const failure = selected?.error ?? global?.error
  const failureId=useRef<string|undefined>(undefined);failureId.current=failure?.id
  useEffect(()=>{recoveryFlight.current=undefined;setRecovering(false);setRecoveryFailed(false)},[failure?.id])
  const retry = selected?.retry?.retry
  const [repairing,setRepairing]=useState(false)
  const [repairError,setRepairError]=useState<string>()
  const repairable=failure!==undefined&&/recovery|reconcil|cleanup unresolved|source drain/i.test(failure.message)
  const repairWorkspace=async()=>{
    if(!failure?.workspaceId)return
    setRepairing(true);setRepairError(undefined)
    try{
      await bridge.request({kind:'desktop/workspace/repair',workspaceId:failure.workspaceId})
      if(failure.sessionId)await bridge.request({kind:'desktop/session/reload',workspaceId:failure.workspaceId,sessionId:failure.sessionId}).catch(()=>undefined)
      setScopes(previous=>{const next=new Map(previous),key=scopeKey(failure.workspaceId,failure.sessionId);next.set(key,{...next.get(key),error:undefined});return next})
    }catch(error){setRepairError(displayError(error).summary)}
    finally{setRepairing(false)}
  }
  const activity = selected?.activity
  const quiet = activity?.phase === "quiet" && !retry
  useEffect(() => {
    if (!retry && !quiet) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [retry, quiet])
  const seconds = retry?.nextAttemptAt ? Math.max(0, Math.ceil((retry.nextAttemptAt - now) / 1000)) : 0
  const waiting = retry?.phase === "waiting" && seconds > 0
  return <>
    {retry || quiet || failure || projection ? <aside className="runtime-feedback" aria-label={t("連線與錯誤通知")}>
      {projection ? <div className="runtime-feedback-card runtime-feedback-warning" role="status" aria-live="polite">
        <AlertCircle size={18} aria-hidden="true" />
        <div><strong>{t("工作狀態與子代理紀錄不一致")}</strong>
          <p>{t("部分子代理工作的狀態可能未正確反映；請查看診斷記錄了解詳情。")}</p>
          <div className="runtime-feedback-actions"><Button variant="ghost" size="small" onClick={onOpenLog}>{t("診斷記錄")}</Button></div>
        </div>
        <Button variant="ghost" size="small" className="runtime-feedback-close" aria-label={t("關閉工作狀態提示")} icon={<X size={15} />} onClick={() => setProjection(undefined)} />
      </div> : null}
      {retry ? <div className="runtime-feedback-card runtime-feedback-retry" role="status" aria-live="polite">
        <LoaderCircle size={18} aria-hidden="true" />
        <div><strong>{t(waiting ? "{seconds} 秒後重試" : "重新連線中…", { seconds })}</strong>
          <p>{retry.code === "CAPACITY" ? t("所選模型暫時已達容量，將重試同一模型。") : t("模型連線暫時中斷，正在自動重試。")}</p>
          <small>{retry.maxRetries === undefined ? t("重試第 {attempt} 次", { attempt: retry.attempt }) : t("重試 {attempt} / {max}", { attempt: retry.attempt, max: retry.maxRetries })}</small>
        </div>
      </div> : null}
      {quiet && activity ? <div className="runtime-feedback-card runtime-feedback-wait" role="status" aria-live="polite">
        <LoaderCircle size={18} aria-hidden="true" />
        <div><strong>{t(activity.waitingFor === "first-response" ? "等待模型回應…" : "等待模型繼續輸出…")}</strong>
          <p>{t("請求已進行 {seconds} 秒。", { seconds: Math.max(0, Math.floor((now - activity.startedAt) / 1000)) })}</p>
        </div>
      </div> : null}
      {failure ? <div className="runtime-feedback-card runtime-feedback-error" role="alert">
        <AlertCircle size={18} aria-hidden="true" /><div><strong>{t("請求未完成")}</strong><p title={failure.message}>{failure.code==='TEAM_RECOVERY_REQUIRED'?t('工作需要恢復，請重試以繼續。'):displayError(failure.message).summary}</p>
          <div className="runtime-feedback-actions">{repairable?<Button variant="ghost" size="small" disabled={repairing} onClick={()=>void repairWorkspace()}>{t(repairing?'正在修復…':'修復工作區')}</Button>:null}{repairError?<small role="status">{repairError}</small>:null}{failure.code==='TEAM_RECOVERY_REQUIRED'&&failure.workspaceId&&failure.sessionId?<Button variant="ghost" size="small" disabled={recovering} onClick={()=>{const flight={};recoveryFlight.current=flight;setRecovering(true);setRecoveryFailed(false);void bridge.request({kind:'desktop/session/input/resume',workspaceId:failure.workspaceId!,sessionId:failure.sessionId!}).then(()=>{setScopes(previous=>{const next=new Map(previous),key=scopeKey(failure.workspaceId,failure.sessionId),current=next.get(key);if(current?.error?.id===failure.id)next.set(key,{...current,error:undefined});return next})},()=>{if(recoveryFlight.current===flight&&failureId.current===failure.id)setRecoveryFailed(true)}).finally(()=>{if(recoveryFlight.current===flight){recoveryFlight.current=undefined;setRecovering(false)}})}}>{t('重試')}</Button>:null}<Button variant="ghost" size="small" onClick={() => setDetails(failure)}>{t("詳細資料")}</Button><Button variant="ghost" size="small" onClick={onOpenLog}>{t("診斷記錄")}</Button></div>{recoveryFailed?<p>{t('重試失敗，請稍後再試。')}</p>:null}
        </div><Button variant="ghost" size="small" className="runtime-feedback-close" aria-label={t("關閉錯誤通知")} icon={<X size={15} />} onClick={() => setScopes(previous => {
          const next = new Map(previous), key = scopeKey(failure.workspaceId, failure.sessionId)
          next.set(key, { ...next.get(key), error: undefined }); return next
        })} />
      </div> : null}
    </aside> : null}
    {details ? <RuntimeDetails key={details.id} bridge={bridge} entry={details} onClose={() => setDetails(undefined)} /> : null}
  </>
}
