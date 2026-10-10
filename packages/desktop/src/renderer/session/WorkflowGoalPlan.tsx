import { useEffect } from "react"
import type { DesktopWorkflowView, WorkflowCommand } from "@i-harness/desktop-gateway/src/workflow.ts"
import { useWorkflowText } from "./workflow-i18n.ts"
import { WorkflowStatus } from "./WorkflowStatus.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import { useSettingsDraft } from "../settings/settings-drafts.tsx"

export type WorkflowMutate = (command: WorkflowCommand) => Promise<boolean>

type Goal = DesktopWorkflowView["goal"]
interface GoalDraft { objective: string; baseline: Goal; dirty: boolean }
interface PlanDraft { enabled: boolean; proposal: string; baseline: DesktopWorkflowView["plan"]; dirty: boolean }
const sameGoal = (left: Goal, right: Goal) => left?.id === right?.id && left?.revision === right?.revision
const samePlan = (left: DesktopWorkflowView["plan"], right: DesktopWorkflowView["plan"]) => left.active === right.active && (left.proposal ?? "") === (right.proposal ?? "")

export function WorkflowGoalPlan({ workspaceId, sessionId, view, disabled, running, mutate }: { workspaceId: string; sessionId: string; view: DesktopWorkflowView; disabled: boolean; running: boolean; mutate: WorkflowMutate }) {
  const t = useWorkflowText()
  const goal = view.goal
  const goalRunning = view.goalRun?.running === true
  const [draft, setDraft] = useSettingsDraft<GoalDraft>(["workflow", workspaceId, sessionId, "goal"], () => ({ objective: goal?.objective ?? "", baseline: goal, dirty: false }))
  const [plan, setPlan] = useSettingsDraft<PlanDraft>(["workflow", workspaceId, sessionId, "plan"], () => ({ enabled: view.plan.active, proposal: view.plan.proposal ?? "", baseline: { ...view.plan }, dirty: false }))
  const goalSnapshot = JSON.stringify(goal), planSnapshot = JSON.stringify(view.plan)
  useEffect(() => { setDraft(current => current.dirty ? current : { objective: goal?.objective ?? "", baseline: goal, dirty: false }) }, [goalSnapshot, draft.dirty, setDraft])
  useEffect(() => { setPlan(current => current.dirty ? current : { enabled: view.plan.active, proposal: view.plan.proposal ?? "", baseline: { ...view.plan }, dirty: false }) }, [planSnapshot, plan.dirty, setPlan])
  const staleGoal = draft.dirty && !sameGoal(draft.baseline, goal)
  const stalePlan = plan.dirty && !samePlan(plan.baseline, view.plan)
  const objective = draft.objective
  function editPlan(patch: Partial<Pick<PlanDraft, "enabled" | "proposal">>) {
    const next = { ...plan, ...patch }
    setPlan({ ...next, dirty: !samePlan({ active: next.enabled, proposal: next.proposal }, plan.baseline) })
  }
  async function change(operation: Extract<WorkflowCommand, { action: "goal" }>["operation"], start = false) {
    const editing = operation === "create" || operation === "edit"
    if (disabled || editing && (staleGoal || !objective.trim() || goal?.phase === "complete") || start && (running || goalRunning)) return
    const baseline = editing ? draft.baseline : goal
    const ref = baseline ? { id: baseline.id, revision: baseline.revision } : undefined
    const submitted = draft
    const saved = await mutate({ action: "goal", operation, request: { ...(ref ? { ref } : {}), ...(editing ? { objective: objective.trim() } : {}) }, ...(start ? { start: true } : {}) })
    if (saved && editing) setDraft(current => current === submitted ? { ...current, dirty: false } : current)
  }
  return <div className="workflow-goal-plan">
    <section className="workflow-card" aria-label={t("目標")}>
      <div className="workflow-heading"><h2>{t("目標")}</h2>{goal ? <WorkflowStatus status={goal.phase} label={goal.phase === "active" ? t("已啟用") : undefined} /> : null}</div>
      {goal ? <><p className="workflow-objective">{goal.objective}</p><span className="workflow-meta">{t("修訂 {revision}", { revision: goal.revision })}</span></> : <p className="muted">{t("尚未設定目標")}</p>}
      {goalRunning ? <p role="status"><WorkflowStatus status="running" /></p> : null}
      {view.goalRun?.error ? <p role="alert" className="error-text">{view.goalRun.error}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); void change(goal ? "edit" : "create") }}>
        <label>{t("目標內容")}<textarea value={objective} maxLength={4096} required disabled={disabled || goal?.phase === "complete"} onChange={(event) => setDraft({ ...draft, objective: event.target.value, dirty: event.target.value !== (draft.baseline?.objective ?? "") })} rows={3} /></label>
        {staleGoal ? <div role="alert" className="workflow-draft-conflict"><p>{t("目標已變更；草稿已保留。比較目前目標後再儲存。")}</p>{draft.baseline ? <details><summary>{t("草稿原本的目標")}</summary><p>{draft.baseline.objective}</p><span className="workflow-meta">{t("修訂 {revision}", { revision: draft.baseline.revision })}</span></details> : null}<div className="workflow-actions"><Button size="small" disabled={disabled} onClick={() => setDraft({ ...draft, baseline: goal, dirty: draft.objective !== (goal?.objective ?? "") })}>{t("保留草稿並採用此目標修訂")}</Button><Button size="small" variant="ghost" disabled={disabled} onClick={() => setDraft({ objective: goal?.objective ?? "", baseline: goal, dirty: false })}>{t("捨棄草稿")}</Button></div></div> : null}
        <div className="workflow-actions">
          <Button type="submit" size="small" disabled={disabled || staleGoal || !objective.trim() || goal?.phase === "complete"}>{t(goal ? "儲存目標" : "建立目標")}</Button>
          {!goal ? <Button size="small" variant="primary" disabled={disabled || staleGoal || running || goalRunning || !objective.trim()} onClick={() => { void change("create", true) }}>{t("建立並開始")}</Button> : goal.phase !== "complete" ? <Button size="small" variant="primary" disabled={disabled || running || goalRunning} onClick={() => { void change("resume", true) }}>{t("開始執行目標")}</Button> : null}
        </div>
      </form>
      {goal ? <div className="workflow-actions">
        {goal.phase === "active" ? <Button size="small" disabled={disabled} onClick={() => { void change("pause") }}>{t("暫停目標")}</Button> : goal.phase === "paused" ? <Button size="small" disabled={disabled} onClick={() => { void change("resume") }}>{t("繼續目標")}</Button> : null}
        {goal.phase !== "complete" ? <Button size="small" disabled={disabled} onClick={() => { void change("complete") }}>{t("完成目標")}</Button> : null}
        <Button size="small" variant="ghost" disabled={disabled} onClick={() => { void change("clear") }}>{t("清除目標")}</Button>
      </div> : null}
      <p className="workflow-hint">{t("目標可在多個回合中持續執行；建立並開始會送出一個新回合。")}</p>
    </section>
    <section className="workflow-card" aria-label={t("計畫模式")}>
      <div className="workflow-heading"><h2>{t("計畫模式")}</h2><span className="workflow-meta">{t(view.plan.active ? "已啟用" : "已停用")}</span></div>
      <form onSubmit={async (event) => { event.preventDefault(); if (disabled || running || stalePlan) return; const submitted = plan; if (await mutate({ action: "plan", enabled: plan.enabled, ...(plan.proposal.trim() ? { proposal: plan.proposal.trim() } : {}) })) setPlan(current => current === submitted ? { ...current, dirty: false } : current) }}>
        <label className="workflow-checkbox"><input type="checkbox" checked={plan.enabled} disabled={disabled || running} onChange={(event) => editPlan({ enabled: event.target.checked })} />{t("計畫模式")}</label>
        <label>{t("計畫內容")}<textarea rows={4} maxLength={4096} value={plan.proposal} disabled={disabled || running} onChange={(event) => editPlan({ proposal: event.target.value })} /></label>
        {stalePlan ? <div role="alert" className="workflow-draft-conflict"><p>{t("計畫已變更；草稿已保留。比較目前計畫後再套用。")}</p><p>{view.plan.proposal || t("尚無計畫內容")}</p><div className="workflow-actions"><Button size="small" disabled={disabled || running} onClick={() => setPlan({ ...plan, baseline: { ...view.plan }, dirty: !samePlan({ active: plan.enabled, proposal: plan.proposal }, view.plan) })}>{t("保留草稿並採用此計畫版本")}</Button><Button size="small" variant="ghost" disabled={disabled || running} onClick={() => setPlan({ enabled: view.plan.active, proposal: view.plan.proposal ?? "", baseline: { ...view.plan }, dirty: false })}>{t("捨棄草稿")}</Button></div></div> : null}
        <div className="workflow-actions"><Button disabled={disabled || running || stalePlan} size="small" type="submit">{t("套用計畫")}</Button></div>
      </form>
      <p className="workflow-hint">{t("計畫模式會限制工具執行；套用內容後，下一個步驟會讀取計畫。")}</p>
      {running ? <p className="workflow-hint">{t("目前回合結束後可變更計畫模式。")}</p> : null}
    </section>
  </div>
}
