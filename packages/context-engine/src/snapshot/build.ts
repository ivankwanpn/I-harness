import { projectConversation, readConversationState, type Session } from "@i-harness/core-session"
import type { ContextCapture, ContextCaptureInput, ContextCoordinateRead, ContextCoordinates, CapturedRequestSurface, UnsupportedContext } from "../contracts/snapshot.ts"
import { captureData } from "./data.ts"
import { contextRevision, semanticContextRevision } from "./revision.ts"
import { contextProtection } from "./protected.ts"

function unsupported(component: UnsupportedContext["component"], sourceIds: readonly string[] = [], code: UnsupportedContext["code"] = "CONTEXT_SNAPSHOT_UNSUPPORTED"): UnsupportedContext {
  return { kind: "unsupported", component, code, sourceIds: Object.freeze([...sourceIds]) }
}

function captureConversation(session: Session, ownerSessionId: string) {
  let sourceIds: readonly string[] = []
  try {
    const projection = projectConversation(session, { ownerSessionId, capturePayload(value, source) {
      sourceIds = [source.id]
      return captureData(value)
    } })
    const state = readConversationState(session, projection)
    if (state.kind === "ambiguous") return unsupported("protection", state.sourceIds, "CONTEXT_STATE_AMBIGUOUS")
    const conversation = captureData(projection), protection = contextProtection(state.state)
    // Empty audit fragments carry no accepted model input. Their unresolved
    // effects remain evidence in protection, never semantic message identity.
    const coordinates: ContextCoordinates = Object.freeze({ ownerSessionId, archive: Object.freeze(state.state.archive),
      semanticRevision: semanticContextRevision(ownerSessionId, conversation),
      protectionRevision: contextRevision("protection", [ownerSessionId, protection, state.state.pending, state.state.turnSourceId ?? null]),
      branchId: contextRevision("branch", [ownerSessionId, state.state.branch]),
      contextEpoch: contextRevision("epoch", [ownerSessionId, state.state.rewrites]),
    })
    return { kind: "available" as const, conversation, protection, coordinates }
  } catch { return unsupported("conversation", sourceIds) }
}

export function captureContextSnapshot(session: Session, input: ContextCaptureInput): ContextCapture {
  let surface: CapturedRequestSurface
  try { surface = captureData(input.surface) } catch { return unsupported("surface") }
  const captured = captureConversation(session, input.ownerSessionId)
  if (captured.kind === "unsupported") return captured
  return { kind: "captured", snapshot: Object.freeze({ version: 1, coordinates: captured.coordinates, conversation: captured.conversation, protection: captured.protection, surface, surfaceRevision: contextRevision("surface", surface) }) }
}

export function readContextCoordinates(session: Session, input: { ownerSessionId: string }): ContextCoordinateRead {
  const captured = captureConversation(session, input.ownerSessionId)
  if (captured.kind === "unsupported") return captured
  const { coordinates } = captured
  return { kind: "available", coordinates, observationRevision: contextRevision("observation", [input.ownerSessionId, coordinates.semanticRevision, coordinates.protectionRevision, coordinates.branchId, coordinates.contextEpoch]) }
}
