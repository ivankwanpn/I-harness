import type { SessionService } from "@i-harness/session-executor"
import type { SessionManagementFence } from "./session-management-fence.ts"

/** A JSONL model-selection rewrite changes the metadata revision held by a
 * resident writer and its Task captures. Retire that writer while idle, then
 * publish the selected wire only after the new header has been acknowledged. */
export async function switchJsonlModel(
  service: Pick<SessionService, "inspectActivity" | "closeSession" | "rebindModel">,
  fence: Pick<SessionManagementFence, "exclusive">,
  sessionId: string,
  binding: Parameters<SessionService["rebindModel"]>[1],
  options: { hasDocument(): boolean; hasActiveWorkflow(): boolean; persist(): Promise<unknown> },
): Promise<void> {
  const idle = () => {
    const activity = service.inspectActivity?.(sessionId)
    if (!activity || activity.active || options.hasActiveWorkflow()) throw new Error("Session is busy: finish active work before changing the saved model")
    return activity
  }
  idle()
  await fence.exclusive(sessionId, async () => {
    if (idle().live || options.hasDocument()) await service.closeSession(sessionId)
    await options.persist()
    service.rebindModel(sessionId, binding)
  }, async () => { idle() })
}

/** Caller holds the router's session transition reservation. Successful changes
 * preserve the live assembly. Failed persistence evicts the transient binding,
 * so the next access resolves the actual durable selection instead of reporting
 * a model that was never saved. */
export async function commitModelSwitch(
  service: Pick<SessionService, "rebindModel" | "closeSession">,
  sessionId: string,
  binding: Parameters<SessionService["rebindModel"]>[1],
  persist: () => Promise<unknown>,
): Promise<void> {
  service.rebindModel(sessionId, binding)
  try { await persist() }
  catch (error) { await service.closeSession(sessionId); throw error }
}
