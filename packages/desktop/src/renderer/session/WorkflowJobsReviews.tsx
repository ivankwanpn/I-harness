import { useEffect, useRef, useState } from "react"
import type { DesktopWorkflowView } from "@i-harness/desktop-gateway/src/workflow.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { WorkflowMutate } from "./WorkflowGoalPlan.tsx"
import { WorkflowStatus } from "./WorkflowStatus.tsx"
import { useWorkflowText, workflowStatus } from "./workflow-i18n.ts"
import { useExecutionText } from "./execution-i18n.ts"
import { OutputBlock } from "./OutputBlock.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"

export function WorkflowJobs({ jobs, bridge, workspaceId, sessionId, disabled, mutate, active: visible = true, error, onRetry }: { jobs: DesktopWorkflowView["jobs"]; bridge: DesktopBridge; workspaceId: string; sessionId: string; disabled: boolean; mutate: WorkflowMutate; active?: boolean; error?: string; onRetry?(): Promise<void> }) {
  const t = useWorkflowText()
  const executionText = useExecutionText()
  const [output, setOutput] = useState<{ id: string; label: string; text?: string; truncated?: boolean; error?: string }>()
  const [confirmCancel, setConfirmCancel] = useState<string>()
  const active = useRef(true)
  const ticket = useRef(0)
  const operation = useRef(0), cancelLock = useRef(false)
  const [canceling, setCanceling] = useState(false), [cancelError, setCancelError] = useState<string>()
  useEffect(() => { active.current = true; ticket.current++; operation.current++; cancelLock.current = false; setCanceling(false); setCancelError(undefined); setOutput(undefined); setConfirmCancel(undefined); return () => { active.current = false; ticket.current++; operation.current++ } }, [workspaceId, sessionId])
  async function readOutput(job: DesktopWorkflowView["jobs"][number]) {
    if (!visible) return
    const current = ++ticket.current
    setOutput({ id: job.jobId, label: job.label })
    try {
      const value = await bridge.request({ kind: "desktop/session/job/output", workspaceId, sessionId, id: job.jobId }) as { text: string; truncated: boolean }
      if (active.current && ticket.current === current) setOutput({ id: job.jobId, label: job.label, ...value })
    } catch (error) { if (active.current && ticket.current === current) setOutput({ id: job.jobId, label: job.label, error: error instanceof Error ? error.message : String(error) }) }
  }
  async function cancelJob() {
    const job = jobs.find(row => row.jobId === confirmCancel)
    if (!visible || disabled || cancelLock.current || !job?.canCancel) return
    const current = operation.current
    cancelLock.current = true; setCanceling(true); setCancelError(undefined)
    try {
      const accepted = await mutate({ action: "job/cancel", id: job.jobId })
      if (!active.current || current !== operation.current) return
      if (accepted) setConfirmCancel(undefined)
      else setCancelError(t("取消工作失敗；請重新讀取後再試。"))
    } catch (reason) { if (active.current && current === operation.current) setCancelError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (active.current && current === operation.current) { cancelLock.current = false; setCanceling(false) } }
  }
  return <section className="workflow-section" aria-label={t("背景任務")}>
    <h2>{t("背景任務")}</h2>
    {jobs.length ? <div className="workflow-list">{[...jobs].reverse().map((job) => <article key={job.jobId} className="workflow-card" aria-label={t("背景任務 {name}", { name: job.label })}>
      <div className="workflow-heading"><h3>{job.label}</h3><WorkflowStatus status={job.status} confirmed={job.live || job.status !== "running"} /></div>
      <p className="workflow-meta">{job.kind} · owner: {sessionId}{job.startedAt === undefined ? "" : ` · ${new Date(job.startedAt).toLocaleString()}`}</p>
      {!job.live && job.status === "running" ? <p className="workflow-hint">{t("已儲存狀態，未確認仍在執行")}</p> : null}
      <div className="workflow-actions">
        {job.outputAvailable || job.live ? <Button size="small" disabled={!visible} onClick={() => { void readOutput(job) }}>{t("查看輸出")}</Button> : null}
        {job.canCancel ? <Button size="small" disabled={disabled || !visible} onClick={() => { setCancelError(undefined); setConfirmCancel(job.jobId) }}>{t("取消工作")}</Button> : null}
      </div>
    </article>)}</div> : <p className="workflow-empty">{t("尚無背景任務")}</p>}
    {output ? <section className="workflow-card workflow-output" aria-label={t("背景任務輸出")}>
      <div className="workflow-heading"><h3>{output.label}</h3><Button size="small" variant="ghost" onClick={() => { ticket.current++; setOutput(undefined) }}>{t("關閉輸出")}</Button></div>
      {output.error ? <p className="error-text" role="alert">{output.error}<Button size="small" disabled={!visible} onClick={() => { const job = jobs.find((item) => item.jobId === output.id); if (job) void readOutput(job) }}>{t("重試")}</Button></p> : output.text === undefined ? <p role="status">{t("正在讀取輸出…")}</p> : output.text || output.truncated ? <OutputBlock label={t("背景任務輸出")} text={output.text} truncated={output.truncated} defaultWrap /> : <p className="workflow-empty">{t("此工作尚無輸出")}</p>}
    </section> : null}
    {visible && confirmCancel ? <SettingsDialog title={executionText("確認程序操作")} closeLabel={t("關閉確認")} busy={canceling} initialFocusSelector="button.workflow-return" onClose={() => setConfirmCancel(undefined)}>
      <p>{executionText("確認對此 owner 的程序／工作執行操作？")} <code>{sessionId} / {confirmCancel}</code></p>
      {!jobs.some(row => row.jobId === confirmCancel && row.canCancel) ? <p role="status">{t("此工作目前無法取消。")}</p> : null}
      {error || cancelError ? <p role="alert" className="error-text">{error ?? cancelError}{onRetry ? <Button size="small" disabled={canceling} onClick={() => { setCancelError(undefined); void onRetry() }}>{t("重試")}</Button> : null}</p> : null}
      <div className="workflow-actions"><Button className="workflow-return" disabled={canceling} onClick={() => setConfirmCancel(undefined)}>{executionText("返回")}</Button><Button variant="danger" loading={canceling} disabled={disabled || !jobs.some(row => row.jobId === confirmCancel && row.canCancel)} onClick={() => { void cancelJob() }}>{executionText("確認執行")}</Button></div>
    </SettingsDialog> : null}
  </section>
}

export function WorkflowReviews({ reviews }: { reviews: DesktopWorkflowView["reviews"] }) {
  const t = useWorkflowText()
  return <section className="workflow-section" aria-label={t("代審記錄")}>
    <h2>{t("代審記錄")}</h2>
    {reviews.length ? <div className="workflow-list">{[...reviews].reverse().map((review) => <details key={review.id} className="workflow-card workflow-review" aria-label={t("代審檢查 {name}", { name: review.request.name })}>
      <summary><span className="workflow-review-name">{review.request.name}</span><WorkflowStatus status={review.outcome ?? review.status} /><span className="workflow-meta">{new Date(review.startedAt).toLocaleString()}</span></summary>
      <dl><dt>{t("代審模型")}</dt><dd>{review.model?.provider || review.model?.model ? [review.model.provider, review.model.model].filter(Boolean).join(" / ") : t("沿用主模型")}{review.model?.protocol ? <span className="workflow-meta"> · {review.model.protocol}</span> : null}</dd>
        {typeof review.durationMs === "number" && Number.isFinite(review.durationMs) && review.durationMs >= 0 ? <><dt>{t("處理時間")}</dt><dd>{review.durationMs} ms · {workflowStatus(review.status, t)}</dd></> : null}
        <dt>{t("請求原因")}</dt><dd>{review.request.reason}</dd>
        <dt>{t("決定理由")}</dt><dd>{review.rationale}</dd>
        {review.reviewerOutcome && review.reviewerOutcome !== review.outcome ? <><dt>{t("模型原始決定")}</dt><dd>{workflowStatus(review.reviewerOutcome, t)}</dd></> : null}
        {review.reviewerRationale && review.reviewerRationale !== review.rationale ? <><dt>{t("模型理由")}</dt><dd>{review.reviewerRationale}</dd></> : null}
      </dl>
      {review.reusedContext ? <p className="workflow-hint">{t("使用既有代審上下文")}</p> : null}
      <OutputBlock label={t("操作參數")} text={review.request.args} language="json" truncated={review.request.argsTruncated} defaultWrap />
    </details>)}</div> : <p className="workflow-empty">{t("尚無代審記錄")}</p>}
  </section>
}
