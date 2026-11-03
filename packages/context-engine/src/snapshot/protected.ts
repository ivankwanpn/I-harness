import type { ConversationState } from "@i-harness/core-session"
import type { ContextProtection } from "../contracts/snapshot.ts"

export function contextProtection(state: ConversationState, current?: { readonly source: { readonly id: string } }): ContextProtection {
  return Object.freeze({ itemIds: Object.freeze(state.itemIds), sourceIds: Object.freeze([...state.sourceIds, ...(current ? [current.source.id] : [])]), pendingInputIds: Object.freeze(state.pendingInputIds), unsettledDelegationIds: Object.freeze(state.unsettledDelegationIds) })
}
