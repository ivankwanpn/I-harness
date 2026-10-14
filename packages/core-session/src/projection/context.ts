import type { Session } from "../events/types.ts"
import { validContextEvent, type ContextRecoveryFacts, type ContextUsageCheckpoint, type RequestBudgetSnapshot } from "../events/context.ts"

export function deriveContextRecovery(session: Session, ownerSessionId: string): ContextRecoveryFacts | undefined {
  let current: ContextRecoveryFacts | undefined
  for (const event of session.events) if (event.type === "context/recovery" && event.ownerSessionId === ownerSessionId && validContextEvent(event)) current = event
  return current
}
export function deriveContextBudget(session: Session, ownerSessionId: string): RequestBudgetSnapshot | undefined {
  let current: RequestBudgetSnapshot | undefined
  for (const event of session.events) if (event.type === "context/budget" && event.snapshot.ownerSessionId === ownerSessionId && validContextEvent(event)) current = event.snapshot
  return current
}
export function deriveContextUsage(session: Session, ownerSessionId: string): ContextUsageCheckpoint | undefined {
  let current: ContextUsageCheckpoint | undefined
  for (const event of session.events) if (event.type === "context/usage" && event.checkpoint.ownerSessionId === ownerSessionId && validContextEvent(event)) current = event.checkpoint
  return current
}
