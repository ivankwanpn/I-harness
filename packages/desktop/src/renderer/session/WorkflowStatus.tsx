/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 packages/ui/src/components/workflow-timeline/
 * WorkflowCardChrome.tsx WorkflowRunStatus: paired state lamp and status word.
 * Modified: I-harness status vocabulary, local labels and CSS, no run graph.
 */
import { useWorkflowText, workflowStatus } from "./workflow-i18n.ts"

export function WorkflowStatus({ status, label, confirmed = true }: { status: string; label?: string; confirmed?: boolean }) {
  const t = useWorkflowText()
  return <span className="workflow-status" data-status={status} data-confirmed={confirmed}>
    <span className="workflow-status-lamp" aria-hidden="true" />
    <span>{label ?? workflowStatus(status, t)}</span>
  </span>
}
