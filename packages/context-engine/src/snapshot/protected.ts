import type { ConversationState } from "@i-harness/core-session"
import type { ContextProtection } from "../contracts/snapshot.ts"

export function contextProtection(state: ConversationState): ContextProtection {
  return Object.freeze({ itemIds: Object.freeze(state.itemIds), sourceIds: Object.freeze(state.sourceIds), pendingInputIds: Object.freeze(state.pendingInputIds), unsettledDelegationIds: Object.freeze(state.unsettledDelegationIds) })
}
