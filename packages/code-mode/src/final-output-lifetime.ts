import type { FactOwner } from '@i-harness/core-session'
import { isOriginalCellFinalization, type OriginalCellFinalization } from './finalization.ts'

/** Independent original source, enrolled at admission. Its lifecycle may await
 * cell finalization; the cell/queue must never await this source's close. */
export function createFinalOutputLifetime<T, Operation extends { finish(): Promise<T> } = { finish(): Promise<T> }>(owner: FactOwner, finalization: OriginalCellFinalization,
  construct: (assertHeld: () => void) => Operation, expectedSessionId?:string) {
  if (!isOriginalCellFinalization(finalization,owner) || finalization.scope !== 'cell-finalization') throw new Error('Original matching mount cell finalization required')
  const action = owner.beginAction()
  if(expectedSessionId!==undefined&&action.owner?.sessionId!==expectedSessionId){action.finish();throw new Error('Original retention action/session mismatch')}
  let operation: ReturnType<typeof construct> | undefined, failed = false, failure: unknown
  let finishOriginal:(()=>Promise<T>)|undefined
  let result: T, finished = false, acknowledged = false
  const source = (() => { try { return action.registerSettlementSource(async () => {
    await finalization.settle()
    if (failed) throw failure
    if (!finished) { result = await finishOriginal!(); finished = true }
  }) } finally { action.finish() } })()
  const held=source.assertHeld.bind(source),close=source.close.bind(source)
  const assertHeld = () => held()
  try { operation = construct(assertHeld);finishOriginal=operation.finish.bind(operation) } catch (cause) { failed = true; failure = cause }
  return Object.freeze({
    assertHeld,
    get operation() { if (failed) throw failure; return operation! },
    async settle(): Promise<T> {
      if (!acknowledged) { await close(); acknowledged = true }
      return result!
    },
  })
}
