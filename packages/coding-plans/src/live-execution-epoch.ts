import { randomUUID } from 'node:crypto'
/** Called only with the tuple already read under the management token lock. */
export function createLiveExecutionEpoch() {
  let current: { sessionId: string; subject: string; workspaceId: string; epoch: string } | undefined
  return (profile: { sessionId: string; subject: string; workspaceId: string }): string => {
    if (!current || current.sessionId !== profile.sessionId || current.subject !== profile.subject || current.workspaceId !== profile.workspaceId) current = { sessionId: profile.sessionId, subject: profile.subject, workspaceId: profile.workspaceId, epoch: randomUUID() }
    return current.epoch
  }
}
