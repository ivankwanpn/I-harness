import { useEffect, useRef, useState } from "react"
import type { DesktopWorkflowView } from "@i-harness/desktop-gateway/src/workflow.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { WorkflowMutate } from "./WorkflowGoalPlan.tsx"
import { WorkflowStatus } from "./WorkflowStatus.tsx"
import { useWorkflowText, workflowStatus } from "./workflow-i18n.ts"

export function WorkflowJobs({ jobs, bridge, workspaceId, sessionId, disabled, mutate }: { jobs: DesktopWorkflowView["jobs"]; bridge: DesktopBridge; workspaceId: string; sessionId: string; disabled: boolean; mutate: WorkflowMutate }) {
  const t = useWorkflowText()
  const [output, setOutput] = useState<{ id: string; label: string; text?: string; truncated?: boolean; error?: string }>()
  const active = useRef(true)
  const ticket = useRef(0)
  useEffect(() => { active.current = true; return () => { active.current = false; ticket.current++ } }, [])
  async function readOutput(job: DesktopWorkflowView["jobs"][number]) {
    const current = ++ticket.current
    setOutput({ id: job.jobId, label: job.label })
    try {
      const value = await bridge.request({ kind: "desktop/session/job/output", workspaceId, sessionId, id: job.jobId }) as { text: string; truncated: boolean }
      if (active.current && ticket.current === current) setOutput({ id: job.jobId, label: job.label, ...value })
    } catch (error) { if (active.current && ticket.current === current) setOutput({ id: job.jobId, label: job.label, error: error instanceof Error ? error.message : String(error) }) }
  }
  return <section className="workflow-section" aria-label={t("背景任務")}>
    <h2>{t("背景任務")}</h2>
    {jobs.length ? <div className="workflow-list">{[...jobs].reverse().map((job) => <article key={job.jobId} className="workflow-card" aria-label={t("背景任務 {name}", { name: job.label })}>
      <div className="workflow-heading"><h3>{job.label}</h3><WorkflowStatus status={job.status} confirmed={job.live || job.status !== "running"} /></div>
      <p className="workflow-meta">{job.kind}{job.startedAt === undefined ? "" : ` · ${new Date(job.startedAt).toLocaleString()}`}</p>
      {!job.live && job.status === "running" ? <p className="workflow-hint">{t("已儲存狀態，未確認仍在執行")}</p> : null}
      <div className="workflow-actions">
        {job.outputAvailable || job.live ? <button onClick={() => { void readOutput(job) }}>{t("查看輸出")}</button> : null}
        {job.canCancel ? <button disabled={disabled} onClick={() => { void mutate({ action: "job/cancel", id: job.jobId }) }}>{t("取消工作")}</button> : null}
      </div>
    </article>)}</div> : <p className="workflow-empty">{t("尚無背景任務")}</p>}
    {output ? <section className="workflow-card workflow-output" aria-label={t("背景任務輸出")}>
      <div className="workflow-heading"><h3>{output.label}</h3><button onClick={() => { ticket.current++; setOutput(undefined) }}>{t("關閉輸出")}</button></div>
      {output.error ? <p className="error-text" role="alert">{output.error}<button onClick={() => { const job = jobs.find((item) => item.jobId === output.id); if (job) void readOutput(job) }}>{t("重試")}</button></p> : output.text === undefined ? <p role="status">{t("正在讀取輸出…")}</p> : <><pre>{output.text || t("此工作尚無輸出")}</pre>{output.truncated ? <p className="workflow-hint">{t("輸出已截斷")}</p> : null}</>}
    </section> : null}
  </section>
}

export function WorkflowReviews({ reviews }: { reviews: DesktopWorkflowView["reviews"] }) {
  const t = useWorkflowText()
  return <section className="workflow-section" aria-label={t("代審記錄")}>
    <h2>{t("代審記錄")}</h2>
    {reviews.length ? <div className="workflow-list">{[...reviews].reverse().map((review) => <details key={review.id} className="workflow-card workflow-review" aria-label={t("代審檢查 {name}", { name: review.request.name })}>
      <summary><span className="workflow-review-name">{review.request.name}</span><WorkflowStatus status={review.outcome ?? review.status} /><span className="workflow-meta">{new Date(review.startedAt).toLocaleString()}</span></summary>
      <dl><dt>{t("代審模型")}</dt><dd>{review.model?.provider || review.model?.model ? [review.model.provider, review.model.model].filter(Boolean).join(" / ") : t("沿用主模型")}{review.model?.protocol ? <span className="workflow-meta"> · {review.model.protocol}</span> : null}</dd>
        <dt>{t("處理時間")}</dt><dd>{review.durationMs} ms · {workflowStatus(review.status, t)}</dd>
        <dt>{t("請求原因")}</dt><dd>{review.request.reason}</dd>
        <dt>{t("決定理由")}</dt><dd>{review.rationale}</dd>
        {review.reviewerOutcome && review.reviewerOutcome !== review.outcome ? <><dt>{t("模型原始決定")}</dt><dd>{workflowStatus(review.reviewerOutcome, t)}</dd></> : null}
        {review.reviewerRationale && review.reviewerRationale !== review.rationale ? <><dt>{t("模型理由")}</dt><dd>{review.reviewerRationale}</dd></> : null}
      </dl>
      {review.reusedContext ? <p className="workflow-hint">{t("使用既有代審上下文")}</p> : null}
      <h4>{t("操作參數")}</h4><pre>{review.request.args}</pre>{review.request.argsTruncated ? <p className="workflow-hint">{t("參數已截斷")}</p> : null}
    </details>)}</div> : <p className="workflow-empty">{t("尚無代審記錄")}</p>}
  </section>
}
