import type { DesktopBridge } from "../../shared/bridge.ts"
import { useId, useState } from "react"
import { PaneTabs } from "../vendor/zcode/PaneTabs.tsx"
import { WorkflowGoalPlan } from "./WorkflowGoalPlan.tsx"
import { WorkflowTeam } from "./WorkflowTeam.tsx"
import { WorkflowJobs, WorkflowReviews } from "./WorkflowJobsReviews.tsx"
import { useWorkflow } from "./use-workflow.ts"
import { useWorkflowText, type WorkflowMessage } from "./workflow-i18n.ts"
import "./workflow.css"

export interface WorkflowPaneProps {
  bridge: DesktopBridge
  workspaceId: string
  sessionId: string
  running?: boolean
  onChanged?(): void
}

/** A selected conversation owns every draft, in-flight response and listener. */
export function WorkflowPane(props: WorkflowPaneProps) {
  return <WorkflowSession key={JSON.stringify([props.workspaceId, props.sessionId])} {...props} />
}

const tabs: { id: string; label: WorkflowMessage }[] = [{ id: "goal", label: "目標與計畫" }, { id: "team", label: "團隊" }, { id: "jobs", label: "背景任務" }, { id: "reviews", label: "代審記錄" }]
function WorkflowSession({ bridge, workspaceId, sessionId, running = false, onChanged }: WorkflowPaneProps) {
  const t = useWorkflowText()
  const id = useId()
  const [tab, setTab] = useState("goal")
  const { view, busy, error, disabled, retry, mutate } = useWorkflow(bridge, workspaceId, sessionId, onChanged)
  return <section className="workflow-pane" aria-label={t("工作流程")}>
    <header className="workflow-pane-header"><h1>{t("工作流程")}</h1><button disabled={busy} onClick={() => { void retry() }}>{t("重新整理")}</button></header>
    <PaneTabs id={id} items={tabs.map((item) => ({ id: item.id, label: t(item.label) }))} selected={tab} onSelect={setTab} label={t("工作流程")} />
    {error ? <p role="alert" className="workflow-error">{error}<button disabled={busy} onClick={() => { void retry() }}>{t("重試")}</button></p> : null}
    {busy ? <p className="workflow-progress" role="status">{t("更新中…")}</p> : null}
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} className="workflow-tab-body">
      {!view ? !error ? <p className="workflow-empty" role="status">{t("正在讀取工作流程…")}</p> : null
        : tab === "goal" ? <WorkflowGoalPlan view={view} disabled={disabled} running={running} mutate={mutate} />
          : tab === "team" ? <WorkflowTeam team={view.team} disabled={disabled} planMode={view.plan.active} running={running} mutate={mutate} />
            : tab === "jobs" ? <WorkflowJobs jobs={view.jobs} bridge={bridge} workspaceId={workspaceId} sessionId={sessionId} disabled={disabled} mutate={mutate} />
              : <WorkflowReviews reviews={view.reviews} />}
    </div>
  </section>
}
