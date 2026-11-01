import type { PreparedModelRequest } from './types.ts'
import { generationError } from './generation.ts'
import { assertOwnedStreamAdmission, associateOwnedStream } from './stream-lifetime.ts'
import { inheritOriginalPassivePrepared } from './passive-observation.ts'

const owned = new WeakSet<PreparedModelRequest>(), sources = new WeakMap<PreparedModelRequest, PreparedModelRequest>()
const streamConstructors = new WeakMap<PreparedModelRequest, PreparedModelRequest['stream']>()
/** Internal auxiliary admission requires the actual tracking constructor, not
 * merely provisional physical-source provenance (which includes raw bases). */
export function ownedPreparedStreamConstructor(prepared: PreparedModelRequest): PreparedModelRequest['stream'] {
  const stream = streamConstructors.get(prepared), descriptor = Object.getOwnPropertyDescriptor(prepared, 'stream')
  if (!stream || !descriptor || !('value' in descriptor) || descriptor.value !== stream) throw generationError('GENERATION_UNSUPPORTED')
  return control => stream.call(prepared, control)
}
/** Read-only provenance through fixed trusted composition, never registration. */
export function preparedExecutionSource(value: PreparedModelRequest): PreparedModelRequest {
  let current = value
  while (sources.has(current)) current = sources.get(current)!
  return current
}
export function isOwnedPreparedTerminal(value: PreparedModelRequest): boolean { return owned.has(value) }
export function assertOwnedPreparedTerminal(value: PreparedModelRequest): void {
  if (!owned.has(value)) throw generationError('GENERATION_UNSUPPORTED')
}
/** Package-private composition bridge. Only fixed terminal/structured wrapper
 * implementations call it; no registrar is exported by the public facade. */
export function ownPreparedTerminal(base: PreparedModelRequest, composition?: { source: PreparedModelRequest; withOutputCap(cap: number | undefined): PreparedModelRequest }): PreparedModelRequest {
  const source = composition?.source
  owned.add(base)
  if (source) sources.set(base, source)
  const prepared: PreparedModelRequest = Object.freeze({
    ...base,
    stream: (control?: import('./types.ts').PreparedStreamControl) => { assertOwnedStreamAdmission(); return associateOwnedStream(base.stream(control)) },
    // A fixed wrapper rebuilds around its single derived inner handle. Deriving
    // base and source independently would record a different, unexecuted source.
    withOutputCap: (cap: number | undefined) => composition ? composition.withOutputCap(cap) : ownPreparedTerminal(base.withOutputCap(cap)),
  })
  owned.add(prepared)
  streamConstructors.set(prepared, prepared.stream)
  sources.set(prepared, source ?? base)
  inheritOriginalPassivePrepared(source??base,prepared)
  return prepared
}
