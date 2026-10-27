import { closedResultMetadata as closed, resultData as data, resultScalars as scalars } from '../../results/metadata.ts'
import { legacyResultMetadata } from './result-metadata.ts'
import type { HeldInheritedResultMetadata } from '../selected-results-types.ts'

type InheritedResult = HeldInheritedResultMetadata extends { legacy(): AsyncIterable<infer Row> } ? Row : never
/** Closed metadata transport from the original protocol owner. This neither
 * constructs a reader nor certifies a caller-supplied eligibility list. */
export function inheritedResultMetadata(raw: unknown): InheritedResult {
  closed(raw, ['ref', 'original', 'extent', 'anchor'])
  const original = data(raw, 'original'), extent = data(raw, 'extent'), anchor = data(raw, 'anchor')
  closed(original, ['kind', 'sessionId', 'seq', 'event', 'slot'])
  const address = scalars(original, ['kind', 'sessionId', 'seq', 'event', 'slot'])
  if (address.kind !== 'local' || typeof address.sessionId !== 'string' || !address.sessionId || !Number.isSafeInteger(address.seq) || (address.seq as number) < 0
    || address.event !== 'context/result-ref' || address.slot !== 'ref') throw new TypeError('Unsupported inherited declaration address')
  closed(extent, data(extent, 'kind') === 'framed' ? ['kind', 'first', 'last'] : ['kind'])
  const selected = scalars(extent, ['kind', 'first', 'last'])
  if (selected.kind !== 'unframed' && (selected.kind !== 'framed' || !Number.isSafeInteger(selected.first) || !Number.isSafeInteger(selected.last) || (selected.first as number) < 1 || (selected.last as number) < (selected.first as number))) throw new TypeError('Invalid inherited extent')
  closed(anchor, data(anchor, 'kind') === 'manifest' ? ['kind', 'seq'] : ['kind', 'manifestSeq', 'ordinal'])
  const basis = scalars(anchor, ['kind', 'seq', 'manifestSeq', 'ordinal'])
  if (basis.kind === 'manifest' ? basis.seq !== 0 : basis.kind !== 'seed-group' || basis.manifestSeq !== 0 || !Number.isSafeInteger(basis.ordinal) || (basis.ordinal as number) < 0) throw new TypeError('Invalid inherited anchor')
  return { ref: legacyResultMetadata(data(raw, 'ref')), original: address, extent: selected, anchor: basis } as InheritedResult
}
/** Preserve the original reader's release path on refusal as well as EOF. */
export async function* iterateHeldInheritedResultMetadata(reader: HeldInheritedResultMetadata, assertCurrent: () => void): AsyncGenerator<InheritedResult> {
  assertCurrent()
  const iterator = reader.legacy()[Symbol.asyncIterator]()
  let complete = false
  try {
    for (;;) {
      assertCurrent(); const next = await iterator.next(); assertCurrent()
      if (next.done) { complete = true; break }
      yield inheritedResultMetadata(next.value)
      assertCurrent()
    }
  } finally {
    if (!complete && iterator.return) {
      const errors: unknown[] = []
      try { assertCurrent() } catch (cause) { errors.push(cause) }
      try { await iterator.return() } catch (cause) { errors.push(cause) }
      try { assertCurrent() } catch (cause) { errors.push(cause) }
      if (errors.length) throw new AggregateError(errors, 'Original inherited result metadata release failed')
    }
    assertCurrent()
  }
}
