import { expect, it } from 'vitest'
import { createCoordinatorAdmission } from '../src/coordinator/public-admission.ts'
import { SessionBindingObservationError } from '../src/coordinator/types.ts'

it('preserves original self-close conflict without poisoning admission, drains accepted IO, and keeps settled close idempotent', async () => {
  const accepted = new Set<Promise<unknown>>()
  const admission = createCoordinatorAdmission(accepted, [], () => Error('Coordinator is closed'), 'Accepted IO failed')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const conflict = new SessionBindingObservationError('conflict')
  let inObservation = false, cleanups = 0
  const preflight = () => { if (inObservation) throw conflict }
  const cleanup = async () => { cleanups++ }
  const operation = admission.track(accepted, async () => {
    inObservation = true
    await expect(admission.retire(cleanup, preflight)).rejects.toBe(conflict)
    admission.assertAdmission()
    // Non-observation self waits still use the generic accepted-flight guard.
    await expect(admission.retire(cleanup)).rejects.toThrow('own accepted operation')
    admission.assertAdmission()
    inObservation = false; entered.resolve()
    await release.promise
    admission.assertContinuation()
    return 'original IO acknowledged'
  })
  try {
    await Promise.race([entered.promise, operation.then(() => { throw Error('Original operation ended before its gate') })])
    const closing = admission.retire(cleanup, preflight)
    expect(admission.retire(async () => { throw Error('Duplicate cleanup') })).toBe(closing)
    expect(() => admission.assertAdmission()).toThrow('closed')
    admission.assertContinuation()
    await Promise.resolve(); expect(cleanups).toBe(0)
    release.resolve()
    expect(await operation).toBe('original IO acknowledged')
    await closing; expect(cleanups).toBe(1)
    await expect(admission.retire(async () => { throw Error('Repeated cleanup') }, () => { throw Error('Retired preflight invoked') })).resolves.toBeUndefined()
    expect(cleanups).toBe(1)
    expect(() => admission.assertContinuation()).toThrow('closed')
  } finally { inObservation = false; release.resolve(); await operation }
})
