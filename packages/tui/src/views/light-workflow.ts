// @i-harness/tui — G2 (M46a): /workflow light panel — the workflow registry
// index (definitions under <workspace>/workflow/*.yml) + live job rows.
// Data: WorkflowDefinition[] (createWorkflowRegistry.list) + BackgroundJobView
// summaries (createWorkflowExecutor.listJobs / createWorkflowJobStore.list).

import type { WorkflowDefinition } from "@i-harness/workflow"
import type { LightPanelRow } from "./light-panel.ts"

export const WORKFLOW_DEFS_EMPTY = "  no workflow definitions (<workspace>/workflow/*.yml)"
export const WORKFLOW_JOBS_EMPTY = "  no workflow jobs running"

/** Minimal job view (structural — the executor's BackgroundJobView/entry). */
export interface WorkflowJobBrief {
  id: string
  status: string
  name?: string
}

/** Definitions index rows (name; detail = step count). */
export function workflowDefRows(defs: WorkflowDefinition[]): LightPanelRow[] {
  if (defs.length === 0) {
    return [{ label: WORKFLOW_DEFS_EMPTY.trim() }]
  }
  return defs.map((d) => ({ label: d.name, detail: `${d.steps.length} steps` }))
}

/** Live job rows (id; detail = status). */
export function workflowJobRows(jobs: WorkflowJobBrief[]): LightPanelRow[] {
  if (jobs.length === 0) {
    return [{ label: WORKFLOW_JOBS_EMPTY.trim() }]
  }
  return jobs.map((j) => ({ label: j.id, detail: j.name ?? String(j.status) }))
}
