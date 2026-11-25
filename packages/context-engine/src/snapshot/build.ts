import { captureRestoredConversationData, readManagedConversationFrontier, type PreparedConversationArchive } from '@i-harness/core-session/internal/restoration'
import { projectConversation, readConversationState, type SessionView as Session } from "@i-harness/core-session"
import type { ContextCapture, ContextCaptureInput, ContextCoordinateRead, ContextCoordinates, ContextSnapshotIdentityRead, CapturedRequestSurface, UnsupportedContext } from "../contracts/snapshot.ts"
import { captureData } from "./data.ts"
import { contextRevision, semanticContextRevision } from "./revision.ts"
import { contextProtection } from "./protected.ts"

function unsupported(component: UnsupportedContext["component"], sourceIds: readonly string[] = [], code: UnsupportedContext["code"] = "CONTEXT_SNAPSHOT_UNSUPPORTED"): UnsupportedContext {
  return { kind: "unsupported", component, code, sourceIds: Object.freeze([...sourceIds]) }
}

// Only scalar evidence survives the capture. The prepared request remains
// the owner of the conversation projection and its message bodies.
const managedCoordinates = new WeakMap<Session, { frontier: number; coordinates: ContextCoordinates }>()
const originalStringify = JSON.stringify
const objectPrototype = Object.prototype
const arrayPrototype = Array.prototype

function managedFrontier(session: Session, ownerSessionId: string): number | undefined {
  // An embedder may replace the serialization environment. Let the ordinary
  // reader construct the digest again in that case.
  if (JSON.stringify !== originalStringify || Object.getPrototypeOf(arrayPrototype) !== objectPrototype
      || Object.hasOwn(objectPrototype, 'toJSON') || Object.hasOwn(arrayPrototype, 'toJSON')) return undefined
  return readManagedConversationFrontier(session, ownerSessionId)
}

function captureConversation(session: Session, ownerSessionId: string) {
  let sourceIds: readonly string[] = []
  try {
    const frontier = managedFrontier(session, ownerSessionId)
    const projection = projectConversation(session, { ownerSessionId, capturePayload(value, source) {
      sourceIds = [source.id]
      return captureData(value)
    } })
    const state = readConversationState(session, projection)
    const captured = finishConversationCapture(projection, state, ownerSessionId)
    if (captured.kind === "available" && frontier !== undefined && managedFrontier(session, ownerSessionId) === frontier) {
      managedCoordinates.set(session, { frontier, coordinates: captured.coordinates })
    }
    return captured
  } catch { return unsupported("conversation", sourceIds) }
}

function conversationCoordinates(session: Session, ownerSessionId: string) {
  const cached = managedCoordinates.get(session)
  if (cached?.coordinates.ownerSessionId === ownerSessionId &&
      managedFrontier(session, ownerSessionId) === cached.frontier) {
    return { kind: "available" as const, coordinates: cached.coordinates }
  }
  return captureConversation(session, ownerSessionId)
}

export function captureContextSnapshot(session: Session, input: ContextCaptureInput): ContextCapture {
  let surface: CapturedRequestSurface
  try { surface = captureData(input.surface) } catch { return unsupported("surface") }
  const captured = captureConversation(session, input.ownerSessionId)
  if (captured.kind === "unsupported") return captured
  return { kind: "captured", snapshot: Object.freeze({ version: 1, coordinates: captured.coordinates, conversation: captured.conversation, protection: captured.protection, surface, surfaceRevision: contextRevision("surface", surface) }) }
}

export function readContextCoordinates(session: Session, input: { ownerSessionId: string }): ContextCoordinateRead {
  const captured = conversationCoordinates(session, input.ownerSessionId)
  if (captured.kind === "unsupported") return captured
  const { coordinates } = captured
  return { kind: "available", coordinates, observationRevision: contextRevision("observation", [input.ownerSessionId, coordinates.semanticRevision, coordinates.protectionRevision, coordinates.branchId, coordinates.contextEpoch]) }
}

/** The exact immutable owner can recheck conversation coordinates without
 * recapturing its payload. The caller supplies the freshly observed surface. */
export function readManagedContextSnapshotIdentity(session: Session, input: ContextCaptureInput): ContextSnapshotIdentityRead | undefined {
  if (managedFrontier(session, input.ownerSessionId) === undefined) return undefined
  let surface: CapturedRequestSurface
  try { surface = captureData(input.surface) } catch { return unsupported("surface") }
  const captured = conversationCoordinates(session, input.ownerSessionId)
  if (captured.kind === "unsupported") return captured
  return { kind: "captured", identity: Object.freeze({ coordinates: captured.coordinates, surfaceRevision: contextRevision("surface", surface) }) }
}

function finishConversationCapture(projection: ReturnType<typeof projectConversation>, state: ReturnType<typeof readConversationState>, ownerSessionId: string) {
    if (state.kind === "ambiguous") return unsupported("protection", state.sourceIds, "CONTEXT_STATE_AMBIGUOUS")
    const conversation = captureData(projection), protection = contextProtection(state.state, conversation.current)
    const effects = state.state.effects ?? []
    // Empty audit fragments carry no accepted model input. Their unresolved
    // effects remain evidence in protection, never semantic message identity.
    const coordinates: ContextCoordinates = Object.freeze({ ownerSessionId, archive: Object.freeze(state.state.archive),
      semanticRevision: semanticContextRevision(ownerSessionId, conversation),
      protectionRevision: contextRevision("protection", [ownerSessionId, protection, state.state.pending, state.state.turnSourceId ?? null, ...(effects.length ? [{ effects }] : [])]),
      branchId: contextRevision("branch", [ownerSessionId, state.state.branch]),
      contextEpoch: contextRevision("epoch", [ownerSessionId, state.state.rewrites]),
    })
    return { kind: "available" as const, conversation, protection, coordinates }
}

function captureRestoredConversation(lease: PreparedConversationArchive, ownerSessionId: string) {
  const paired = captureRestoredConversationData(lease, ownerSessionId)
  if (paired.kind === 'unsupported') return unsupported('conversation', paired.sourceIds)
  try { return finishConversationCapture(paired.projection, paired.state, ownerSessionId) }
  catch { return unsupported('conversation', paired.sourceIds) }
}
/** Internal original-document consumer; nominal preparation has no Session fallback. */
export function captureRestoredContextSnapshot(lease: PreparedConversationArchive, input: ContextCaptureInput): ContextCapture {
  let surface: CapturedRequestSurface
  try { surface=captureData(input.surface) } catch { return unsupported('surface') }
  const captured=captureRestoredConversation(lease,input.ownerSessionId)
  if(captured.kind==='unsupported')return captured
  return {kind:'captured',snapshot:Object.freeze({version:1,coordinates:captured.coordinates,conversation:captured.conversation,protection:captured.protection,surface,surfaceRevision:contextRevision('surface',surface)})}
}
export function readRestoredContextCoordinates(lease: PreparedConversationArchive,input:{ownerSessionId:string}):ContextCoordinateRead {
  const captured=captureRestoredConversation(lease,input.ownerSessionId)
  if(captured.kind==='unsupported')return captured
  const {coordinates}=captured
  return {kind:'available',coordinates,observationRevision:contextRevision('observation',[input.ownerSessionId,coordinates.semanticRevision,coordinates.protectionRevision,coordinates.branchId,coordinates.contextEpoch])}
}
