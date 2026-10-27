import { expect, it } from 'vitest'
import type { ManagedAction, ProducerFactOutcome, SessionView, SettlementFacts } from '../src/index.ts'
import { subscribe } from '../src/index.ts'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const identities = new WeakMap<object, number>()
let nextIdentity = 0
export function traceCheckpoint(label: string, objects: Record<string, object>, detail: unknown) {
  const identity = Object.fromEntries(Object.entries(objects).map(([key, value]) => {
    if (!identities.has(value)) identities.set(value, ++nextIdentity)
    return [key, identities.get(value)]
  }))
  appendFileSync(join(process.env.IH_STRUCTURE_EVIDENCE_ROOT!, 'checkpoint-identities.jsonl'), JSON.stringify({ label, identity, detail }) + '\n')
}

export const terminal = { type: 'context/recovery' as const, version: 1 as const, ownerSessionId: 'owner', recoveryId: 'original', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), state: 'blocked' as const, retryConsumed: true }
export function ownerState() {
  const state = { revision: 0, pending: 0, recoveryPending: 0, failed: false }
  const work = { async settle(): Promise<{ kind: 'advanced' } | { kind: 'blocked'; reason: unknown }> { return { kind: 'advanced' } } }
  const owner = {
    readCut() { return { ...state } },
    settle() { return work.settle() },
    isCurrent(cut: typeof state) { return Object.keys(state).every(key => state[key as keyof typeof state] === cut[key as keyof typeof state]) },
  }
  return { state, owner, work }
}
export type CheckpointFixture = {
  action: ManagedAction<ProducerFactOutcome>
  view: SessionView
  cleanup(expectedRecovery?: boolean): Promise<void>
  assertOptional(): void
}

// The shared controls exercise the real public source and capture handles in
// both adapters. Native fixtures use the actual owned JSONL coordinator.
export function checkpointControls(fixture: () => Promise<CheckpointFixture>, committed: 'committed' | 'memory-committed') {
  it('drains the fixed original captures and retains the same live source after checkpoint', async () => {
    const f = await fixture(), { owner } = ownerState(); let drains = 0
    const source = f.action.registerSettlementSource(async () => { drains++ }, undefined, owner)
    try {
      const original = source.recovery.capture(terminal)
      expect(await source.checkpoint()).toEqual({ kind: 'settled' })
      const disposition = await original.observe()
      expect(disposition).toMatchObject({ kind: committed, seqs: [0] })
      traceCheckpoint('original-checkpoint', { action: f.action, source, owner, original }, { cut: owner.readCut(), disposition, active: true, drains })
      expect(drains).toBe(0); source.assertHeld()
      const later = source.recovery.capture({ ...terminal, recoveryId: 'later' })
      expect(await later.admit()).toMatchObject({ kind: committed, seqs: [1] })
      expect(await source.checkpoint()).toEqual({ kind: 'settled' })
      await source.close(); expect(drains).toBe(1)
      expect(() => source.assertHeld()).toThrow()
    } finally { f.action.finish(); await f.cleanup() }
  })

  it.each(['softReduction', 'inputPreparation', 'generation'] as const)('tracks a valid special %s constructor through original checkpoint settlement', async kind => {
    const f = await fixture(), { owner } = ownerState(), digest = 'a'.repeat(64), ownerSessionId = f.action.owner?.sessionId ?? 'owner'
    try {
      if (kind === 'softReduction') {
        expect(await f.action.captureSoftReduction({ type: 'context/soft-reduction', version: 1, op: 'start', ownerSessionId, sequenceId: 'soft', workKey: digest, sourceKey: digest, protectionKey: digest, policyKey: digest, acceptedExchanges: 0, humanTurns: 0 }, () => true).admit()).toMatchObject({ kind: committed })
      } else {
        expect(await f.action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'raw', text: '/raw', delivery: 'queue', intent: 'user', preparationPolicy: 'human-host', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })).toMatchObject({ kind: committed })
        expect(await f.action.captureGeneration([{ type: 'context/action', version: 1, op: 'open', ownerSessionId, actionId: 'generation', purpose: 'main', origin: { kind: 'input', seq: 0 }, startedAt: 100, expiresAt: 3600100, trustedAt: 100 }], () => true).admit()).toMatchObject({ kind: committed })
        if (kind === 'inputPreparation') expect(await f.action.captureInputPreparation({ type: 'agent/input/preparation', version: 1, preparationId: 'prepare', actionId: 'generation', actionSeq: 1, admissionSeq: 0, inputId: 'raw', op: 'started', startedAt: 100 }, () => true).admit()).toMatchObject({ kind: committed })
      }
      const source = f.action.registerSettlementSource(async () => {}, undefined, owner)
      const capture = kind === 'softReduction'
        ? source.softReduction.capture({ type: 'context/soft-reduction', version: 1, op: 'terminal', ownerSessionId, sequenceId: 'soft', workKey: digest, sourceKey: digest, startSeq: { kind: 'prior', seq: 0, expectedType: 'context/soft-reduction' }, outcome: 'failed', publication: 'none', consumedBeforeKey: digest })
        : kind === 'generation'
          ? source.generation.capture({ type: 'context/action', version: 1, op: 'close', ownerSessionId, actionId: 'generation', trustedAt: 100, disposition: 'stopped' })
          : source.inputPreparation.capture({ type: 'agent/input/preparation', version: 1, preparationId: 'prepare', actionId: 'generation', actionSeq: 1, admissionSeq: 0, inputId: 'raw', op: 'completed', observations: [] })
      const firstSeq = f.view.events.length
      source.holdRecovery(); await source.checkpoint()
      const disposition = await capture.observe()
      expect(disposition).toMatchObject({ kind: committed, seqs: [firstSeq] })
      traceCheckpoint('special-original-capture', { action: f.action, source, owner, capture }, { kind, cut: owner.readCut(), disposition })
      f.assertOptional(); await source.close()
    } finally { f.action.finish(); await f.cleanup() }
  })

  it('does not issue a pre-captured later candidate before its owner permits settlement', async () => {
    const f = await fixture(), { owner, state, work } = ownerState(), reason = { boundary: 'earlier-original' }
    state.pending = 1; state.recoveryPending = 1
    work.settle = async () => ({ kind: 'blocked', reason })
    const source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    try {
      const later = source.recovery.capture(terminal); source.holdRecovery()
      await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', errors: [reason] })
      expect(await later.observe()).toMatchObject({ kind: 'not-issued' }); expect(f.view.events).toHaveLength(0)
      state.pending = state.recoveryPending = 0; state.revision++
      work.settle = async () => ({ kind: 'advanced' })
      await source.checkpoint(); expect(await later.observe()).toMatchObject({ kind: committed })
      await source.close()
    } finally { f.action.finish(); await f.cleanup() }
  })

  it('verifies a fresh second cut after original settlement changes the owner', async () => {
    const f = await fixture(), { owner, state, work } = ownerState(); let calls = 0
    state.pending = state.recoveryPending = 1
    work.settle = async () => { calls++; if (calls === 1) { state.pending = state.recoveryPending = 0; state.revision++ }; return { kind: 'advanced' } }
    const source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    try { source.holdRecovery(); await source.checkpoint(); expect(calls).toBe(2); f.assertOptional(); await source.close() }
    finally { f.action.finish(); await f.cleanup() }
  })

  it('releases an actual resolved own hold as progress while preserving later pending and a foreign hold', async () => {
    const f = await fixture(), { owner, state, work } = ownerState()
    const foreign = f.action.registerSettlementSource(async () => {}), source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    try {
      state.pending = 1; source.holdRecovery(); foreign.holdRecovery()
      work.settle = async () => ({ kind: 'blocked', reason: 'earlier optional store' })
      expect(await source.checkpoint()).toEqual({ kind: 'progress' }); source.assertHeld()
      traceCheckpoint('actual-own-hold-progress', { action: f.action, source, owner, foreign }, { cut: owner.readCut(), ownHoldReleased: true, foreignHoldRemains: true, active: true })
      expect(() => f.assertOptional()).toThrow()
      await foreign.close(); f.assertOptional()
      await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      state.pending = 0; state.revision++; work.settle = async () => ({ kind: 'advanced' })
      await source.close()
    } finally { f.action.finish(); await f.cleanup() }
  })

  it('never clears another original source sticky recovery when releasing its resolved transient hold', async () => {
    const f = await fixture(), { owner } = ownerState()
    const foreign = f.action.registerSettlementSource(async () => {}), source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    try {
      source.holdRecovery(); foreign.requireRecovery()
      expect(await source.checkpoint()).toEqual({ kind: 'settled' }); source.assertHeld()
      expect(() => f.assertOptional()).toThrow(); await source.close(); await foreign.close()
      expect(() => f.assertOptional()).toThrow()
    } finally { f.action.finish(); await f.cleanup(true) }
  })

  it.each(['prepare-only', 'capture', 'repeat-hold', 'seal'] as const)('invalidates both awaited owner cuts for %s and keeps the original hold', async mutation => {
    const f = await fixture(), { owner, state, work } = ownerState(); let calls = 0
    const source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    work.settle = async () => {
      calls++; await Promise.resolve()
      if (mutation === 'capture') source.recovery.capture({ ...terminal, recoveryId: `late-${calls}` })
      else if (mutation === 'repeat-hold') source.holdRecovery()
      else { state.revision++; if (mutation === 'prepare-only') state.pending++ }
      return { kind: 'advanced' }
    }
    try {
      source.holdRecovery()
      await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      expect(calls).toBe(2); expect(f.view.events).toHaveLength(0); expect(() => f.assertOptional()).toThrow()
      state.pending = 0; state.revision++; work.settle = async () => ({ kind: 'advanced' })
      await source.checkpoint(); await source.close()
    } finally { f.action.finish(); await f.cleanup() }
  })

  it('invalidates reconcile-stage changes before entering native auto-drain', async () => {
    const f = await fixture(), { owner, state } = ownerState(); let calls = 0, mutate = true
    const source = f.action.registerSettlementSource(async () => {}, async () => { calls++; await Promise.resolve(); if (mutate) state.revision++ }, owner)
    try {
      source.recovery.capture(terminal); source.holdRecovery()
      await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      expect(calls).toBe(2); expect(f.view.events).toHaveLength(0)
      mutate = false; await source.checkpoint(); await source.close()
    } finally { f.action.finish(); await f.cleanup() }
  })

  it('excludes a late capture from the frozen native drain and refuses a pending second cut', async () => {
    const f = await fixture(), { owner, state } = ownerState()
    const source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    let late: ReturnType<typeof source.recovery.capture> | undefined
    const off = subscribe(f.view, () => {
      if (late) return
      late = source.recovery.capture({ ...terminal, recoveryId: 'late' }); state.pending = state.recoveryPending = 1; state.revision++; source.holdRecovery()
    })
    try {
      source.recovery.capture(terminal)
      await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      expect(f.view.events).toHaveLength(1); expect(await late!.observe()).toMatchObject({ kind: 'not-issued' })
      off(); state.pending = state.recoveryPending = 0; state.revision++
      await source.checkpoint(); await source.close()
    } finally { off(); f.action.finish(); await f.cleanup() }
  })

  it.each(['prepare-only', 'repeat-hold', 'seal'] as const)('checks %s after awaited native disposition before continuing the original snapshot', async mutation => {
    const f = await fixture(), { owner, state } = ownerState()
    const source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    let calls = 0
    const off = subscribe(f.view, () => {
      if (++calls !== 1) return
      if (mutation === 'repeat-hold') source.holdRecovery()
      else { state.revision++; if (mutation === 'prepare-only') state.pending = state.recoveryPending = 1 }
    })
    try {
      const first = source.recovery.capture(terminal), second = source.recovery.capture({ ...terminal, recoveryId: 'second' })
      source.holdRecovery()
      // A changed owner/H stops snapshot iteration after first. Only the
      // second explicit pass can issue second; that disposition changes C,
      // requiring a later original checkpoint rather than a stale success.
      await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      expect(await first.observe()).toMatchObject({ kind: committed })
      expect(f.view.events).toHaveLength(mutation === 'prepare-only' ? 1 : 2)
      if (mutation === 'prepare-only') expect(await second.observe()).toMatchObject({ kind: 'not-issued' })
      expect(() => f.assertOptional()).toThrow()
      traceCheckpoint('post-native-cut-invalidated', { source, owner, first, second }, { mutation, cut: owner.readCut(), events: f.view.events.length })
      off(); state.pending = state.recoveryPending = 0; state.revision++
      await source.checkpoint(); await source.close()
    } finally { off(); f.action.finish(); await f.cleanup() }
  })

  it('does not report settled after late prepare-only work even when its old hold can progress', async () => {
    const f = await fixture(), { owner, state, work } = ownerState(); let first = true
    work.settle = async () => { if (first) { first = false; state.pending = 1; state.revision++ }; return { kind: 'advanced' } }
    const source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    try {
      source.holdRecovery(); expect(await source.checkpoint()).toEqual({ kind: 'progress' }); source.assertHeld()
      expect(state.pending).toBe(1); await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      state.pending = 0; state.revision++; await source.close()
    } finally { f.action.finish(); await f.cleanup() }
  })

  it('refuses final retirement when lifecycle drain enrolls unresolved owner work', async () => {
    const f = await fixture(), { owner, state } = ownerState(); let enroll = true
    const source = f.action.registerSettlementSource(async () => { if (enroll) { state.pending = 1; state.revision++ } }, undefined, owner)
    try {
      await expect(source.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' }); source.assertHeld()
      state.pending = 0; state.revision++; enroll = false; await source.close()
    } finally { f.action.finish(); await f.cleanup() }
  })

  it.each([undefined, null, false, 0, ''])('preserves raw falsey lifecycle drain failure %s and retains original source for retry', async reason => {
    const f = await fixture(), { owner } = ownerState(); let fails = true
    const source = f.action.registerSettlementSource(async () => { if (fails) throw reason }, undefined, owner)
    try {
      await expect(source.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', errors: [reason] }); source.assertHeld()
      fails = false; await source.close()
    } finally { f.action.finish(); await f.cleanup() }
  })

  it('installs checkpoint and close latches before registered callbacks reenter', async () => {
    const f = await fixture(), { owner, work } = ownerState()
    let source: SettlementFacts<ProducerFactOutcome>, first: ReturnType<typeof source.checkpoint>, reentered: ReturnType<typeof source.checkpoint> | undefined
    work.settle = async () => { reentered = source.checkpoint(); return { kind: 'advanced' } }
    let closing: Promise<void>, nestedClose: Promise<void> | undefined
    source = f.action.registerSettlementSource(async () => { nestedClose = source.close() }, undefined, owner)
    try {
      first = source.checkpoint(); expect(source.checkpoint()).toBe(first); await first; expect(reentered).toBe(first)
      closing = source.close(); await closing; expect(nestedClose).toBe(closing)
    } finally { f.action.finish(); await f.cleanup() }
  })

  it('lets checkpoint advance while close waits outside its stage lane for the owner seal', async () => {
    const f = await fixture(), { owner, state } = ownerState(), entered = Promise.withResolvers<void>(), seal = Promise.withResolvers<void>()
    const source = f.action.registerSettlementSource(async () => { entered.resolve(); await seal.promise }, undefined, owner)
    try {
      const closing = source.close(); expect(source.close()).toBe(closing); await entered.promise
      source.holdRecovery(); expect(await source.checkpoint()).toEqual({ kind: 'settled' }); source.assertHeld()
      expect(await source.recovery.capture(terminal).admit()).toMatchObject({ kind: committed })
      state.revision++; seal.resolve(); await closing; expect(() => source.assertHeld()).toThrow()
    } finally { seal.resolve(); f.action.finish(); await f.cleanup() }
  })

  it('captures descriptor receivers and functions once at original registration', async () => {
    const f = await fixture(), { owner } = ownerState(); const receivers: unknown[] = []
    const original = owner.readCut; owner.readCut = function () { receivers.push(this); return original.call(this) }
    const source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    owner.readCut = () => { throw Error('replacement must never run') }; owner.settle = async () => { throw Error('replacement must never run') }; owner.isCurrent = () => false
    try { await source.checkpoint(); expect(receivers).toEqual([owner]); await source.close() }
    finally { f.action.finish(); await f.cleanup() }
  })

  it.each([undefined, null, false, 0, ''])('retains raw falsey owner failure %s as sticky and never invokes the failed callback again', async reason => {
    const f = await fixture(), { owner, work } = ownerState(); let calls = 0
    work.settle = async () => { calls++; throw reason }
    const source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    try {
      source.holdRecovery()
      await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', errors: [reason] })
      expect(calls).toBe(1); expect(() => f.assertOptional()).toThrow(); source.assertHeld()
      await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', errors: [reason] })
      await expect(source.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', errors: [reason] })
      expect(calls).toBe(1); expect(() => f.assertOptional()).toThrow(); source.assertHeld()
      traceCheckpoint('sticky-falsey-settle-failure', { action: f.action, source, owner }, { reasonType: typeof reason, reason, calls, active: true, holdRetained: true })
    } finally { f.action.finish(); await f.cleanup(true) }
  })

  it.each([undefined, null, false, 0, ''])('retains a raw falsey blocked prerequisite %s without sticky callback replay', async reason => {
    const f = await fixture(), { owner, state, work } = ownerState(); let calls = 0, blocked = true
    state.pending = state.recoveryPending = 1
    work.settle = async () => { calls++; return blocked ? { kind: 'blocked', reason } : { kind: 'advanced' } }
    const source = f.action.registerSettlementSource(async () => {}, undefined, owner)
    try {
      source.holdRecovery(); await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', errors: [reason] })
      expect(calls).toBe(1); expect(() => f.assertOptional()).toThrow()
      blocked = false; state.pending = state.recoveryPending = 0; state.revision++
      await source.checkpoint(); f.assertOptional(); await source.close()
    } finally { f.action.finish(); await f.cleanup() }
  })

  it('refuses checkpoint for ordinary sources and still asserts their real lifetime', async () => {
    const f = await fixture(), source = f.action.registerSettlementSource(async () => {})
    try {
      await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_OWNER_UNSUPPORTED' }); await source.close()
      expect(() => source.checkpoint()).toThrow()
    } finally { f.action.finish(); await f.cleanup() }
  })
}


