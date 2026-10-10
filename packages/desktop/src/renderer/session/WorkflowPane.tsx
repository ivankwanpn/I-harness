import type { DesktopBridge } from "../../shared/bridge.ts"
import { useEffect, useId, useState } from "react"
import { PaneTabs } from "../vendor/zcode/PaneTabs.tsx"
import { WorkflowGoalPlan } from "./WorkflowGoalPlan.tsx"
import { WorkflowTeam } from "./WorkflowTeam.tsx"
import { WorkflowJobs, WorkflowReviews } from "./WorkflowJobsReviews.tsx"
import { useWorkflow } from "./use-workflow.ts"
import { useWorkflowText, type WorkflowMessage } from "./workflow-i18n.ts"
import "./workflow.css"
import { Button } from "../vendor/opencode/Button.tsx"
import { SettingsDraftScope } from "../settings/settings-drafts.tsx"

export interface WorkflowPaneProps {
  bridge: DesktopBridge
  workspaceId: string
  sessionId: string
  running?: boolean
  onChanged?(): void
  section?: "goal" | "team" | "jobs" | "reviews"
  active?: boolean
}

/** A selected conversation owns every draft, in-flight response and listener. */
export function WorkflowPane(props: WorkflowPaneProps) {
  return <SettingsDraftScope owner={props.bridge}><WorkflowSession key={JSON.stringify([props.workspaceId, props.sessionId])} {...props} /></SettingsDraftScope>
}

const tabs: { id: string; label: WorkflowMessage }[] = [{ id: "goal", label: "目標與計畫" }, { id: "team", label: "團隊" }, { id: "jobs", label: "背景任務" }, { id: "reviews", label: "代審記錄" }]
function WorkflowSession({ bridge, workspaceId, sessionId, running = false, onChanged, section = "goal", active = true }: WorkflowPaneProps) {
  const t = useWorkflowText()
  const id = useId()
  const [tab, setTab] = useState(section)
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([section]))
  useEffect(() => { setTab(section) }, [section])
  useEffect(() => { setVisited(current => current.has(tab) ? current : new Set(current).add(tab)) }, [tab])
  const { view, busy, error, disabled, retry, mutate } = useWorkflow(bridge, workspaceId, sessionId, onChanged, active)
  const mounted = (name: string) => tab === name || visited.has(name)
  return <section className="workflow-pane" aria-label={t("工作流程")} aria-busy={busy || !view && !error || undefined}>
    <header className="workflow-pane-header"><h1>{t("工作流程")}</h1><Button size="small" variant="ghost" disabled={busy || !active} onClick={() => { void retry() }}>{t("重新整理")}</Button></header>
    <PaneTabs id={id} items={tabs.map((item) => ({ id: item.id, label: t(item.label) }))} selected={tab} onSelect={(id) => setTab(id as typeof section)} label={t("工作流程")} />
    {error ? <p role="alert" className="workflow-error">{error}<Button size="small" variant="ghost" disabled={busy || !active} onClick={() => { void retry() }}>{t("重試")}</Button></p> : null}
    {busy ? <p className="workflow-progress" role="status">{t("更新中…")}</p> : null}
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} className="workflow-tab-body">
      {!view ? !error && active ? <p className="workflow-empty" role="status">{t("正在讀取工作流程…")}</p> : null : <>
        {mounted("goal") ? <div hidden={tab !== "goal"}><WorkflowGoalPlan workspaceId={workspaceId} sessionId={sessionId} view={view} disabled={disabled} running={running} mutate={mutate} /></div> : null}
        {mounted("team") ? <div hidden={tab !== "team"}><WorkflowTeam workspaceId={workspaceId} sessionId={sessionId} team={view.team} disabled={disabled} planMode={view.plan.active} running={running} mutate={mutate} /></div> : null}
        {mounted("jobs") ? <div hidden={tab !== "jobs"}><WorkflowJobs jobs={view.jobs} bridge={bridge} workspaceId={workspaceId} sessionId={sessionId} active={active && tab === "jobs"} disabled={disabled} mutate={mutate} error={error} onRetry={retry} /></div> : null}
        {mounted("reviews") ? <div hidden={tab !== "reviews"}><WorkflowReviews reviews={view.reviews} /></div> : null}
      </>}
    </div>
  </section>
}
