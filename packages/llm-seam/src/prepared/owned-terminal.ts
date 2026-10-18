import type { PreparedModelRequest } from './types.ts'
import { generationError } from './generation.ts'

const owned = new WeakSet<PreparedModelRequest>(), sources = new WeakMap<PreparedModelRequest, PreparedModelRequest>()
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
export function ownPreparedTerminal(base: PreparedModelRequest, source?: PreparedModelRequest): PreparedModelRequest {
  owned.add(base)
  if (source) sources.set(base, source)
  const prepared: PreparedModelRequest = Object.freeze({
    ...base,
    withOutputCap: (cap: number | undefined) => ownPreparedTerminal(base.withOutputCap(cap), source?.withOutputCap(cap)),
  })
  owned.add(prepared)
  sources.set(prepared, source ?? base)
  return prepared
}
