import { expect } from 'vitest'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSession, createNondurableFactOwner, type ManagedAction, type ProducerFactOutcome, type SettlementFacts } from '@i-harness/core-session'

export type TestAction<Outcome extends ProducerFactOutcome = ProducerFactOutcome> = ManagedAction<Outcome>
export type TestSource<Outcome extends ProducerFactOutcome = ProducerFactOutcome> = SettlementFacts<Outcome>

/** Exercise the same installer used by the consuming fixture, at real registration. */
export async function assertSettlementRegistrationForwarding(
  install: (action: TestAction) => TestAction,
  options: { instrumentedDrain?: boolean; earlyDrain?: boolean } = {},
) {
  const action = createNondurableFactOwner(createSession()).beginAction()
  const register = action.registerSettlementSource
  let receiver: unknown, registered: Parameters<typeof register> | undefined, originalSource: ReturnType<typeof register> | undefined
  action.registerSettlementSource = function (...args) {
    receiver = this; registered = args
    originalSource = register.apply(this, args)
    return originalSource
  }
  let drained = 0, reconciled = 0, settled = 0
  const drain = async () => { drained++ }, reconcile = async () => { reconciled++ }
  const cut = Object.freeze({ revision: 0, pending: 0, recoveryPending: 0, failed: false })
  const checkpointOwner = Object.freeze({ readCut: () => cut, settle: async () => { settled++; return { kind: 'advanced' as const } }, isCurrent: (candidate: typeof cut) => candidate === cut })
  const wrapped = install(action)
  try {
    const source = wrapped.registerSettlementSource(drain, reconcile, checkpointOwner)
    const evidenceRoot = process.env.IH_STRUCTURE_EVIDENCE_ROOT
    if (evidenceRoot) appendFileSync(join(evidenceRoot, 'adapter-registration.jsonl'), JSON.stringify({
      test: expect.getState().currentTestName, receiverMatches: receiver === action,
      argumentCount: registered?.length, drainMatches: registered?.[0] === drain,
      instrumentedDrain: options.instrumentedDrain === true,
      reconcileMatches: registered?.[1] === reconcile, descriptorMatches: registered?.[2] === checkpointOwner,
      sourceMatches: source === originalSource,
    }) + '\n')
    expect.soft(receiver).toBe(action)
    expect.soft(registered).toHaveLength(3)
    if (options.instrumentedDrain) expect.soft(registered?.[0]).not.toBe(drain)
    else expect.soft(registered?.[0]).toBe(drain)
    expect.soft(registered?.[1]).toBe(reconcile)
    expect.soft(registered?.[2]).toBe(checkpointOwner)
    expect.soft(source).toBe(originalSource)
    await expect(source.checkpoint()).resolves.toEqual({ kind: 'settled' })
    expect(reconciled).toBeGreaterThan(0); expect(settled).toBeGreaterThan(0)
    expect(drained).toBe(options.earlyDrain ? 1 : 0)
    await source.close()
    expect(drained).toBe(options.earlyDrain ? 2 : 1)
    expect(() => source.assertHeld()).toThrow()
  } finally { await originalSource?.close(); action.finish() }
}
