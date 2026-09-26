import type { SessionService } from "@i-harness/session-executor"

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
