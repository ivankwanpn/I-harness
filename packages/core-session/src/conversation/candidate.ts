import type { SessionEvent } from '../events/types.ts'
import type { SessionView, SessionEventView, DeepReadonly } from '../managed/types.ts'
import { captureLegacyFact, isStrictFactData, freezeJsonData } from '../managed/capture.ts'
import { eventArchive, extendedEventArchive } from './archive.ts'
import type { ConversationPayloadCapture } from './payload.ts'
import type { ConversationProjection } from './types.ts'
import { renderConversationItems } from './render-items.ts'
import { createConversationValidationIndex } from './validation.ts'

type RewriteEvent = Extract<SessionEvent, { type: 'compaction/replacement' | 'compaction/prune' | 'compaction/reset' }>
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> & { readonly seq?: never } : never
type ConversationRewriteDraft = DeepReadonly<WithoutSeq<RewriteEvent>>
interface ConversationCandidate {
  readonly kind: 'candidate'
  readonly candidateId: string
  readonly sourceEventCount: number
  readonly projectedEventCount: number
  readonly projection: ConversationProjection
}

/** Strict proposal data precedes capture: no getter, toJSON or sparse slots. */
function captureRewrites(rewrites: readonly ConversationRewriteDraft[], baseCount: number): readonly SessionEventView[] {
  const invalid = () => { throw new TypeError('Invalid conversation rewrite proposal') }
  if (!isStrictFactData(rewrites) || !Array.isArray(rewrites) || !rewrites.length) invalid()
  const pending: unknown[] = [rewrites]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Array.isArray(value) && (Reflect.ownKeys(value).length !== value.length + 1
      || Array.from({ length: value.length }, (_, index) => descriptors[String(index)]).some(slot => !slot?.enumerable))) invalid()
    for (const [key, descriptor] of Object.entries(descriptors)) if (key !== 'length' || !Array.isArray(value)) {
      if (!descriptor.enumerable) invalid()
      pending.push(descriptor.value)
    }
  }
  for (const draft of rewrites) {
    if (!draft || typeof draft !== 'object' || Object.hasOwn(draft, 'seq')
      || !['compaction/replacement', 'compaction/prune', 'compaction/reset'].includes(draft.type)) invalid()
  }
  const captured = captureLegacyFact(rewrites)
  if (captured.kind !== 'captured') return invalid()
  return Object.freeze(captured.value.map((draft, offset) => freezeJsonData({ ...draft, seq: baseCount + offset })))
}

/** Prospective data only: this validates and renders without installing facts. */
export function projectConversationCandidate(source: SessionView, rewrites: readonly ConversationRewriteDraft[], options: {
  candidateId: string
  ownerSessionId?: string
  capturePayload?: ConversationPayloadCapture
}): ConversationCandidate {
  const candidateId = options.candidateId
  if (typeof candidateId !== 'string' || !candidateId.length || candidateId.length > 256) throw new TypeError('Invalid conversation candidate id')
  const base = eventArchive(source.events), suffix = captureRewrites(rewrites, base.length)
  const index = createConversationValidationIndex(source.events, { formatVersion: source.formatVersion })
  const stage = index.stage(suffix)
  const projection = renderConversationItems(extendedEventArchive(base, suffix), stage.history(), {
    ownerSessionId: options.ownerSessionId, capturePayload: options.capturePayload, header: source.header,
    candidate: { id: candidateId, baseCount: base.length },
  })
  return Object.freeze({ kind: 'candidate', candidateId, sourceEventCount: base.length, projectedEventCount: base.length + suffix.length, projection })
}
