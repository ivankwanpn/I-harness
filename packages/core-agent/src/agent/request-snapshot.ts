import { captureContextSnapshot, type ContextSnapshot, type ContextRevision, type RequestSurfaceInput } from "@i-harness/context-engine"
import { renderConversation, type ContextBindingMetadata, type Session } from "@i-harness/core-session"
import { projectionFingerprint } from "@i-harness/token-meter"
import type { ModelClient } from "@i-harness/llm-seam"

export interface RequestEvidence {
  readonly executionIdentity?: import("@i-harness/llm-seam").LiveExecutionIdentity
  readonly snapshot: ContextSnapshot
  readonly model: ModelClient
  readonly bindingIdentity?: object
  readonly projectionRevision: number
  readonly neutralFingerprint: string
  readonly metadata?: ContextBindingMetadata
}

/** Capture synchronously after the logical hooks/claim, before any await. */
export function captureRequestCandidate(session: Session, ownerSessionId: string, selected: { model: ModelClient; bindingIdentity?: object; executionIdentity?: import("@i-harness/llm-seam").LiveExecutionIdentity }, surface: RequestSurfaceInput, projectionRevision: number): RequestEvidence {
  const result = captureContextSnapshot(session, { ownerSessionId, surface })
  if (result.kind === "unsupported") throw Object.assign(new Error(`${result.code}: ${result.component}`), { code: result.code, component: result.component, sourceIds: result.sourceIds })
  const snapshot = result.snapshot
  return { snapshot, ...selected, projectionRevision, neutralFingerprint: projectionFingerprint(renderConversation(snapshot.conversation)), metadata: snapshot.surface.binding }
}

export function sameRequestCandidate(before: RequestEvidence, current: RequestEvidence): boolean {
  const a = before.snapshot.coordinates, b = current.snapshot.coordinates
  return before.model === current.model && before.bindingIdentity === current.bindingIdentity
    && a.semanticRevision === b.semanticRevision && a.protectionRevision === b.protectionRevision
    && a.branchId === b.branchId && a.contextEpoch === b.contextEpoch && before.snapshot.surfaceRevision === current.snapshot.surfaceRevision
}

export function requestContextIdentity(evidence: RequestEvidence): { version: 1; semanticRevision: ContextRevision; protectionRevision: ContextRevision; branchId: ContextRevision; contextEpoch: ContextRevision; surfaceRevision: ContextRevision } {
  const { semanticRevision, protectionRevision, branchId, contextEpoch } = evidence.snapshot.coordinates
  return { version: 1 as const, semanticRevision, protectionRevision, branchId, contextEpoch, surfaceRevision: evidence.snapshot.surfaceRevision }
}
