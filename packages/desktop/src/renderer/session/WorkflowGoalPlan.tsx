import { useEffect, useState } from "react"
import type { DesktopWorkflowView, WorkflowCommand } from "@i-harness/desktop-gateway/src/workflow.ts"
import { useWorkflowText } from "./workflow-i18n.ts"
import { WorkflowStatus } from "./WorkflowStatus.tsx"

export type WorkflowMutate = (command: WorkflowCommand) => Promise<boolean>

export function WorkflowGoalPlan({ view, disabled, running, mutate }: { view: DesktopWorkflowView; disabled: boolean; running: boolean; mutate: WorkflowMutate }) {
  const t = useWorkflowText()
  const goal = view.goal
  const goalRunning = view.goalRun?.running === true
  const [objective, setObjective] = useState(goal?.objective ?? "")
  const [enabled, setEnabled] = useState(view.plan.active)
  const [proposal, setProposal] = useState(view.plan.proposal ?? "")
  useEffect(() => { setObjective(goal?.objective ?? "") }, [goal?.id, goal?.objective])
  useEffect(() => { setEnabled(view.plan.active); setProposal(view.plan.proposal ?? "") }, [view.plan.active, view.plan.proposal])
  function change(operation: Extract<WorkflowCommand, { action: "goal" }>["operation"], start = false) {
    const ref = goal ? { id: goal.id, revision: goal.revision } : undefined
    void mutate({ action: "goal", operation, request: { ...(ref ? { ref } : {}), ...(operation === "create" || operation === "edit" ? { objective: objective.trim() } : {}) }, ...(start ? { start: true } : {}) })
  }
  return <div className="workflow-goal-plan">
    <section className="workflow-card" aria-label={t("目標")}>
      <div className="workflow-heading"><h2>{t("目標")}</h2>{goal ? <WorkflowStatus status={goal.phase} label={goal.phase === "active" ? t("已啟用") : undefined} /> : null}</div>
      {goal ? <><p className="workflow-objective">{goal.objective}</p><span className="workflow-meta">{t("修訂 {revision}", { revision: goal.revision })}</span></> : <p className="muted">{t("尚未設定目標")}</p>}
      {goalRunning ? <p role="status"><WorkflowStatus status="running" /></p> : null}
      {view.goalRun?.error ? <p role="alert" className="error-text">{view.goalRun.error}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); if (objective.trim()) change(goal ? "edit" : "create") }}>
        <label>{t("目標內容")}<textarea value={objective} maxLength={4096} required disabled={disabled || goal?.phase === "complete"} onChange={(event) => setObjective(event.target.value)} rows={3} /></label>
        <div className="workflow-actions">
          <button type="submit" disabled={disabled || !objective.trim() || goal?.phase === "complete"}>{t(goal ? "儲存目標" : "建立目標")}</button>
          {!goal ? <button type="button" className="workflow-primary" disabled={disabled || running || goalRunning || !objective.trim()} onClick={() => change("create", true)}>{t("建立並開始")}</button> : goal.phase !== "complete" ? <button type="button" className="workflow-primary" disabled={disabled || running || goalRunning} onClick={() => change("resume", true)}>{t("開始執行目標")}</button> : null}
        </div>
      </form>
      {goal ? <div className="workflow-actions">
        {goal.phase === "active" ? <button disabled={disabled} onClick={() => change("pause")}>{t("暫停目標")}</button> : goal.phase === "paused" ? <button disabled={disabled} onClick={() => change("resume")}>{t("繼續目標")}</button> : null}
        {goal.phase !== "complete" ? <button disabled={disabled} onClick={() => change("complete")}>{t("完成目標")}</button> : null}
        <button disabled={disabled} onClick={() => change("clear")}>{t("清除目標")}</button>
      </div> : null}
      <p className="workflow-hint">{t("目標可在多個回合中持續執行；建立並開始會送出一個新回合。")}</p>
    </section>
    <section className="workflow-card" aria-label={t("計畫模式")}>
      <div className="workflow-heading"><h2>{t("計畫模式")}</h2><span className="workflow-meta">{t(view.plan.active ? "已啟用" : "已停用")}</span></div>
      <form onSubmit={(event) => { event.preventDefault(); void mutate({ action: "plan", enabled, ...(proposal.trim() ? { proposal: proposal.trim() } : {}) }) }}>
        <label className="workflow-checkbox"><input type="checkbox" checked={enabled} disabled={disabled || running} onChange={(event) => setEnabled(event.target.checked)} />{t("計畫模式")}</label>
        <label>{t("計畫內容")}<textarea rows={4} maxLength={4096} value={proposal} disabled={disabled || running} onChange={(event) => setProposal(event.target.value)} /></label>
        <div className="workflow-actions"><button disabled={disabled || running} type="submit">{t("套用計畫")}</button></div>
      </form>
      <p className="workflow-hint">{t("計畫模式會限制工具執行；套用內容後，下一個步驟會讀取計畫。")}</p>
      {running ? <p className="workflow-hint">{t("目前回合結束後可變更計畫模式。")}</p> : null}
    </section>
  </div>
}
