import { expect, it } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextOutputService, contextSourceIdentity, type LegacyReadObservation } from '../src/index.ts'
import { createSessionCoordinator, compileSemanticSeed, type BootstrapTargetPreparationRequest } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createSession, append, exportConversationSeed, type BootstrapPreparationFacts } from '@i-harness/core-session'

it('uses actual unmanaged outer F0 before B2 without target profiles or project binding writes', async () => {
  const evidence = process.env.IH_LEGACY_FORK_EVIDENCE_ROOT
  if (evidence) await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(join(evidence ?? tmpdir(), 'ih-l1-f0-')), storage = join(root, 'sessions'), sourceId = contextSourceIdentity('workspace', root)
  let coordinator = createSessionCoordinator(createJsonlBackend(storage), { lock: { enabled: true } })
  let service = createContextOutputService({ root, workspaceId: 'workspace', config: { enabled: true }, requireObservedLegacyRecipients: true })
  try {
    const ref = await service.capture({ sessionId: 'source', callId: 'original', label: 'result', text: 'VISIBLE unmanaged original', complete: true })
    if (!ref) throw Error('Actual legacy capture failed')
    const source = createSession(); append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'input' }); append(source, { type: 'context/result-ref', ref }); append(source, { type: 'turn/end' })
    await coordinator.create({ sessionId: 'source' }); await coordinator.append('source', source.events)
    const document = await coordinator.openManagedDocument('source'), view = document.view, count = view.events.length, selection = { kind: 'completed' as const }
    const exported = exportConversationSeed(view, { kind: 'session', sessionId: 'source' }, selection)
    if (exported.kind !== 'seed') throw Error('Actual B1 export failed')
    const invocation = { version: 1 as const, operationId: 'unmanaged-original', targetSessionId: 'target', createdAt: '2026-10-25T00:00:00.000Z', requestDigest: 'e'.repeat(64) }
    const request = { invocation, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'source' }, seed: compileSemanticSeed(exported) }
    let sourceHooks = 0
    async function run(passive: boolean) {
      return coordinator.withSessionBindingObservation!({ existingSessionIds: passive ? [] : ['source'], target: invocation }, async f0 => {
        let prepared = false
        const current = () => { f0.assertCurrent(); if (!passive) { sourceHooks++; document.assertReady(); if (document.view !== view || view.events.length !== count) throw Error('Source witness changed') } }
        const target = () => { f0.assertCurrent(); if (!prepared || f0.binding('target').kind !== 'absent') throw Error('Unmanaged target is not prepared') }
        const sourceRead: LegacyReadObservation = { sessionId: 'source', sourceId, assertCurrent: current, localVisible: c => c.refId === ref!.id, anchorVisible: () => false }
        const scope = service.registerLegacyForkTransfer({ invocation, sourceSessionId: 'source', semanticSeedDigest: exported.kind === 'seed' ? exported.digest : '', sourceObservationDigest: exported.kind === 'seed' ? exported.sourceObservationDigest : '', selection,
          target: { available: () => true, assertCurrent: target, sourceId: () => sourceId }, ...(!passive ? { source: { view, read: sourceRead, assertCurrent: current } } : {}) })
        const checkPreparation = async (phase: BootstrapTargetPreparationRequest, facts?: BootstrapPreparationFacts) => {
          f0.assertCurrent()
          expect(f0.binding('target')).toEqual({ kind: 'absent' })
          if (!passive) { expect(f0.binding('source')).toEqual({ kind: 'absent' }); expect(f0.metadata('source').sessionId).toBe('source') }
          const actual = await coordinator.inspectBootstrap(invocation); f0.assertCurrent()
          if (!['reserved', 'ready'].includes(actual.kind) || !actual.token || !('manifestDigest' in actual.token) || actual.token.manifestDigest !== phase.manifestDigest || !facts || facts.manifestDigest !== phase.manifestDigest) throw Error('Actual unmanaged reservation unavailable')
          prepared = true; target()
        }
        const guards = { assertCurrent: current, dependencies: { async confirm() { throw Error('Empty closure') }, async reconcile() { throw Error('Empty closure') } }, targetPreparation: {
          assertTargetCurrent: target,
          async confirm(phase: BootstrapTargetPreparationRequest, fresh: () => boolean, facts?: BootstrapPreparationFacts) { await checkPreparation(phase, facts); return service.confirmLegacyForkTransfer(scope, phase, fresh, facts!) },
          async reconcile(phase: BootstrapTargetPreparationRequest, facts?: BootstrapPreparationFacts) { await checkPreparation(phase, facts); return service.reconcileLegacyForkTransfer(scope, phase, facts!) },
        } }
        try { return passive ? await coordinator.resumeSemanticTarget(invocation, guards) : await coordinator.bootstrapSemanticTarget(request, guards) }
        finally { await service.closeLegacyForkTransfer(scope) }
      })
    }
    expect((await run(false)).kind).toBe('ready')
    await service.clear('source'); await coordinator.closeManagedDocument('source')
    await service.close(); await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(storage), { lock: { enabled: true } })
    service = createContextOutputService({ root, workspaceId: 'workspace', config: { enabled: true }, requireObservedLegacyRecipients: true })
    const before = sourceHooks; expect((await run(true)).kind).toBe('already-ready'); expect(sourceHooks).toBe(before)
    const ready = await coordinator.openManagedDocument('target'), seed = ready.view.header!.semanticSeed!
    const read: LegacyReadObservation = { sessionId: 'target', sourceId, bootstrap: { invocation, manifestDigest: seed.manifestDigest, seedDigest: seed.seedDigest }, assertCurrent: () => ready.assertReady(), localVisible: () => false, anchorVisible: anchor => anchor.kind === 'seed-group' && ready.view.events.some(event => event.type === 'conversation/seed-group' && event.ordinal === anchor.ordinal) }
    expect((await service.readLegacyObserved({ sessionId: 'target' }, { refId: ref.id }, read)).text).toContain('VISIBLE')
    expect((await service.searchLegacyObserved({ sessionId: 'target' }, { query: 'VISIBLE' }, read)).hits.map(hit => hit.ref.id)).toEqual([ref.id])
  } finally { await service.close(); await coordinator.close() }
}, 15000)
