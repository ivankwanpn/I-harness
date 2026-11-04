import type { TaskProjectionIssue } from '@i-harness/subagent'

/** D-01 host diagnostic: read-only projection check at an explicit reload point.
 * Never mutates the document (reconcile stays an explicit request) and never
 * fails the reload because the projection owner is unavailable. */
export async function reportTaskProjectionIssues(
  service: { taskProjectionIntegrity?(sessionId: string, options?: { reconcile?: boolean }): Promise<TaskProjectionIssue[]> },
  sessionId: string,
  warn: (message: string) => void = message => console.warn(message),
): Promise<TaskProjectionIssue[]> {
  try {
    const issues = await service.taskProjectionIntegrity?.(sessionId) ?? []
    if (issues.length > 0) warn(`[desktop] task projection issues for ${sessionId}: ${issues.map(issue => issue.kind).join(', ')}`)
    return issues
  } catch {
    return []
  }
}
