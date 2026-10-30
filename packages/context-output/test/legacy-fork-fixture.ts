import { mkdtemp, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createContextOutputService, contextSourceIdentity, type LegacyForkCapture, type LegacyReadObservation, type LegacyPreparationRequest } from '../src/index.ts'
import { compileSemanticSeed, type BootstrapTargetPreparationPort } from '../../session-persistence/src/index.ts'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createProjectScopeBroker } from '../../desktop-gateway/src/project-scope.ts'
import { createBootstrapRequestIntent } from '../../session-persistence/src/coordinator/bootstrap-intent.ts'
import { createSession, append, exportConversationSeed } from '@i-harness/core-session'

export async function legacyFixture(options: { observations?: number; disabled?: boolean; f0Warm?: boolean; path?: string; mixed?: boolean; distinct?: number; summary?: boolean; retentionDays?: number } = {}) {
  const evidence = process.env.IH_LEGACY_FORK_EVIDENCE_ROOT
  if (evidence) await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(join(evidence ?? tmpdir(), 'ih-l1-')), workspace = join(root, 'workspace'); await mkdir(workspace)
  const project = { id: 'p', name: 'Project', roots: [await realpath(workspace)], primaryRoot: await realpath(workspace) }
  const sourceId = contextSourceIdentity('workspace', project.primaryRoot, project)
  const readScopes = new Map<string, () => import('../../session-executor/src/index.ts').ResultReadScope>()
  let deleted!: (documents: readonly string[]) => Promise<void>
  const authorizeResult: NonNullable<import('../src/types.ts').ContextOutputOptions['authorizeResult']> = (access, metadata) => {
    const scope = readScopes.get(access.sessionId)?.()
    return !!scope && (!metadata.owner.source || metadata.owner.source.sourceId === contextSourceIdentity('workspace', project.primaryRoot, scope.scope))
  }
  let service = createContextOutputService({ root, workspaceId: 'workspace', requireObservedLegacyRecipients: true, config: { enabled: true, ...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}) }, authorizeResult, documentDeletions: listener => { deleted = listener; return () => {} } })
  let coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
  let broker = createProjectScopeBroker(coordinator, workspace)
  coordinator.onDocumentDeleted!(id => deleted([id]))
  await coordinator.create({ sessionId: 'source' }); await broker.configure(project); await broker.bind('source', 'p')
  readScopes.set('source', (await broker.resultReadScopeFor('source'))!)
  const refs = []
  for (const name of ['VISIBLE', 'HIDDEN', 'FUTURE']) {
    const ref = await service.capture({ sessionId: 'creator', callId: name, label: name, text: `${name} retained text`, complete: true, source: { sourceId, ...(options.path ? { path: options.path } : {}) } })
    if (!ref) throw Error('Fixture capture failed')
    await service.grant({ sessionId: 'creator' }, [ref.id], 'source'); refs.push(ref)
  }
  const [visible, hidden, future] = refs as [NonNullable<typeof refs[number]>, NonNullable<typeof refs[number]>, NonNullable<typeof refs[number]>]
  const selectedRefs = [visible]
  for (let i = 1; i < (options.distinct ?? 1); i++) {
    const ref = await service.capture({ sessionId: 'creator', callId: `VISIBLE-${i}`, label: 'visible', text: `VISIBLE retained text ${i}`, complete: true, source: { sourceId } })
    if (!ref) throw Error('Distinct actual capture refused')
    await service.grant({ sessionId: 'creator' }, [ref.id], 'source'); selectedRefs.push(ref)
  }
  let managed: { catalog: import('@i-harness/core-session').ManagedArtifactRef; member: import('@i-harness/core-session').ManagedArtifactRef } | undefined
  if (options.mixed) {
    const scope = service.registerResultScope({ operationId: 'member-original', sessionId: 'source', callId: 'exec', source: { sourceId } }, () => true), sink = await service.beginResult(scope, 'exec-frames-v1')
    await sink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n'))
    const member = await sink.finish('complete'); if (member.kind !== 'committed') throw Error('Actual member capture failed')
    const entries: import('@i-harness/core-session').ResultDependency[] = [{ kind: 'exec-frames', sourceId: 'native', retention: { kind: 'artifact', ref: member.ref } }, { kind: 'exec-frames', sourceId: 'alias', retention: { kind: 'artifact', ref: member.ref } }]
    const catalogScope = service.registerResultDependencyScope({ operationId: 'catalog-original', sessionId: 'source', callId: 'VISIBLE', source: { sourceId } }, () => true, entries), catalogSink = await service.beginResult(catalogScope, 'json-utf8-v1')
    await catalogSink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries })))
    const catalog = await catalogSink.finish('complete'); if (catalog.kind !== 'committed') throw Error('Actual catalog capture failed')
    expect(await service.settleResultDependencyMembership(catalogScope, catalog.ref)).toBe('ready')
    managed = { catalog: catalog.ref, member: member.ref }
  }
  const source = createSession()
  append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'selected' })
  if (managed) {
    append(source, { type: 'step/start' }); append(source, { type: 'tool/call', callId: 'VISIBLE', name: 'read', args: {} }); append(source, { type: 'assistant/message', text: '' })
    append(source, { type: 'tool/result', callId: 'VISIBLE', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: 'inline preview', media: [], retention: { kind: 'unavailable', reason: 'quota', observedEncodedBytes: 0 }, dependencies: { kind: 'artifact-set', ref: managed.catalog, count: 2 } } })
    append(source, { type: 'step/end' })
  }
  for (let i = 0; i < (options.observations ?? 1); i++) for (const ref of selectedRefs) append(source, { type: 'context/result-ref', ref })
  const selectedEnd = source.events.length; append(source, { type: 'turn/end' })
  if (options.summary) append(source, { type: 'compaction/summary', text: 'selected summary', shadowedSeqs: [1] })
  const hiddenStart = source.events.length
  append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'hidden' }); append(source, { type: 'context/result-ref', ref: hidden }); append(source, { type: 'turn/end' })
  append(source, { type: 'rewind/point', version: 1, targetTurn: 2, anchorSeq: hiddenStart, mode: 'conversation', fileOps: [] })
  append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'future' }); append(source, { type: 'context/result-ref', ref: future })
  await coordinator.append('source', source.events)
  const document = await coordinator.openManagedDocument('source'), view = document.view, eventCount = view.events.length
  const selection = { kind: 'completed' as const, atSeq: selectedEnd }
  const exported = exportConversationSeed(view, { kind: 'session', sessionId: 'source' }, selection)
  if (exported.kind !== 'seed') throw Error('Fixture B1 export failed: ' + JSON.stringify(exported))
  const seedExport = exported
  const { intent, requestDigest } = createBootstrapRequestIntent({ action: 'fork', selection }, { kind: 'project', projectId: 'p' })
  const invocation = { version: 1 as const, operationId: 'original', targetSessionId: 'target', createdAt: '2026-10-25T00:00:00.000Z', requestDigest }
  const request = { invocation, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'source' }, seed: compileSemanticSeed(exported) }
  let alive = true, sourceCalls = 0, acquired = 0, preparationCalls = 0
  let phase: LegacyPreparationRequest | undefined, actualFacts: import('@i-harness/core-session').BootstrapPreparationFacts | undefined
  if (options.disabled) await service.configure({ enabled: false })
  async function run(passive = false, changeCapture?: (capture: LegacyForkCapture) => void, beforeConfirm?: (facts: import('@i-harness/core-session').BootstrapPreparationFacts) => void, ownerOnly = false, afterAttempt?: (scope: import('../src/index.ts').LegacyForkTransferScope) => Promise<void>) {
      const current = () => { if (passive) throw Error('Passive scope cannot issue B2 work'); document.assertReady(); if (!alive || view !== document.view || view.events.length !== eventCount) throw Error('Original source changed') }
      const preparation = broker.prepareBootstrapInheritance({ invocation, requestIntent: intent, sourceSessionId: 'source', sourceAvailable: () => { sourceCalls++; return !passive && alive }, assertNewWorkCurrent: current, targetAvailable: () => true })
      let managedScope: import('../src/index.ts').SeedDependencyTransferScope | undefined
      const dependencyScope = (input: import('@i-harness/core-session').BootstrapDependencyRequest) => managedScope ??= service.registerSeedDependencyTransfer({
        binding: { operationId: invocation.operationId, sourceSessionId: 'source', targetSessionId: invocation.targetSessionId, targetDocumentId: invocation.targetSessionId, manifestDigest: input.manifestDigest },
        sourceAccess: { sessionId: 'source' }, sourceAvailable: () => !passive && alive, assertSourceCurrent() { current(); preparation.assertSourceCurrent() },
        targetAvailable: () => true, assertTargetCurrent: preparation.targetPreparation.assertTargetCurrent,
        targetScope() { const scope = preparation.targetScope(); return { source: { sourceId: contextSourceIdentity('workspace', project.primaryRoot, scope.scope), readonly: true }, revision: scope.revision } },
      })
      const dependencies = {
        async confirm(input: import('@i-harness/core-session').BootstrapDependencyRequest, fresh: () => boolean) { if (!managed) throw Error('Empty managed closure must not call confirm'); return service.confirmSeedDependencies(dependencyScope(input), input, fresh) },
        async reconcile(input: import('@i-harness/core-session').BootstrapDependencyRequest) { if (!managed) throw Error('Empty managed closure must not call reconcile'); return service.reconcileSeedDependencies(dependencyScope(input), input) },
      }
      if (options.f0Warm && !phase) {
        const reserved = await coordinator.bootstrapSemanticTarget(request, { assertCurrent: current, dependencies, targetPreparation: {
          async confirm(input, _current, facts) { phase = input; actualFacts = facts; return { kind: 'blocked', reason: 'unavailable' } },
          async reconcile() { throw Error('No original legacy application yet') }, assertTargetCurrent() { throw Error('No target preparation yet') },
        } })
        expect(reserved.kind).toBe('blocked')
      }
      if (options.f0Warm) {
        const preparedOutside = passive ? await preparation.targetPreparation.reconcile(phase!) : await preparation.targetPreparation.confirm(phase!, () => { current(); return true })
        expect(preparedOutside).toEqual({ kind: 'confirmed' })
      }
      try {
      const work = async (f0?: import('../../session-persistence/src/index.ts').SessionBindingObservation) => {
      if (f0) acquired++
      const scopedCurrent = () => { f0?.assertCurrent(); current() }
      const read: LegacyReadObservation = { sessionId: 'source', sourceId, assertCurrent: scopedCurrent, localVisible: c => selectedRefs.some(ref => c.refId === ref.id), anchorVisible: () => false }
      const capture: LegacyForkCapture = { invocation, sourceSessionId: 'source', semanticSeedDigest: seedExport.digest, sourceObservationDigest: seedExport.sourceObservationDigest, selection,
        target: { available: () => true, assertCurrent() { f0?.assertCurrent(); preparation.targetPreparation.assertTargetCurrent() }, sourceId() { const scope = preparation.targetScope(); return contextSourceIdentity('workspace', project.primaryRoot, scope.scope) } },
        ...(!passive ? { source: { view, read, assertCurrent() { sourceCalls++; scopedCurrent(); preparation.assertSourceCurrent() } } } : {}) }
      changeCapture?.(capture)
      const scope = service.registerLegacyForkTransfer(capture)
      const port: BootstrapTargetPreparationPort = {
        assertTargetCurrent: preparation.targetPreparation.assertTargetCurrent,
        async confirm(input, isCurrent, facts) {
          preparationCalls++; phase = input; actualFacts = facts
          expect(facts).toBeDefined(); beforeConfirm?.(facts!)
          await expect(coordinator.profile(invocation.targetSessionId)).rejects.toThrow()
          const prepared = options.f0Warm ? await preparation.targetPreparation.reconcile(input, facts) : await preparation.targetPreparation.confirm(input, isCurrent, facts)
          if (options.f0Warm) { preparation.assertSourceCurrent(); expect(isCurrent()).toBe(true) }
          if (prepared.kind !== 'confirmed') return prepared
          return service.confirmLegacyForkTransfer(scope, input, isCurrent, facts!)
        },
        async reconcile(input, facts) {
          phase = input; actualFacts = facts
          const prepared = await preparation.targetPreparation.reconcile(input, facts)
          if (prepared.kind !== 'confirmed') return prepared
          return service.reconcileLegacyForkTransfer(scope, input, facts!)
        },
      }
      const guards = { assertCurrent: scopedCurrent, targetPreparation: port, dependencies }
      try {
        const outcome = ownerOnly ? passive ? await port.reconcile(phase!, actualFacts) : await port.confirm(phase!, () => { scopedCurrent(); return true }, actualFacts) : passive ? await coordinator.resumeSemanticTarget(invocation, guards) : await coordinator.bootstrapSemanticTarget(request, guards)
        await afterAttempt?.(scope)
        if (outcome.kind === 'ready' || outcome.kind === 'already-ready') readScopes.set(invocation.targetSessionId, (await broker.resultReadScopeFor(invocation.targetSessionId))!)
        return outcome
      }
      finally { await service.closeLegacyForkTransfer(scope) }
      }
      return options.f0Warm ? await coordinator.withSessionBindingObservation!({ existingSessionIds: passive ? [] : ['source'], target: invocation }, work) : await work()
      } finally { preparation.close() }
  }
  async function observation(): Promise<LegacyReadObservation> {
    const ready = await coordinator.openManagedDocument('target'); ready.assertReady()
    const getter = await broker.resultReadScopeFor('target'), scope = getter!(), seed = ready.view.header?.semanticSeed
    if (!seed) throw Error('Target has no READY seed')
    return { sessionId: 'target', sourceId: contextSourceIdentity('workspace', project.primaryRoot, scope.scope),
      bootstrap: { invocation, manifestDigest: seed.manifestDigest, seedDigest: seed.seedDigest },
      assertCurrent() { ready.assertReady(); if (getter!().revision !== scope.revision) throw Error('Project scope changed') }, localVisible: () => false,
      anchorVisible(anchor) { return anchor.kind === 'manifest' || anchor.kind === 'seed-group' && ready.view.events.some(e => e.type === 'conversation/seed-group' && e.ordinal === anchor.ordinal) } }
  }
  return { root, workspace, project, sourceId, visible, selectedRefs, hidden, future, managed, document, view, exported, request, run, observation,
    service: () => service, coordinator: () => coordinator, broker: () => broker,
    sourceCalls: () => sourceCalls, acquired: () => acquired, preparationCalls: () => preparationCalls, phase: () => phase!, facts: () => actualFacts!,
    async sourceClear() { await service.clear('source'); alive = false; await coordinator.closeManagedDocument('source') },
    async reopen() {
      await service.close(); await broker.close(); await coordinator.close()
      coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
      coordinator.onDocumentDeleted!(id => deleted([id]))
      broker = createProjectScopeBroker(coordinator, workspace); await broker.configure(project)
      readScopes.clear()
      service = createContextOutputService({ root, workspaceId: 'workspace', requireObservedLegacyRecipients: true, config: { enabled: true }, authorizeResult, documentDeletions: listener => { deleted = listener; return () => {} } })
    },
    async close() { await service.close(); await broker.close(); await coordinator.close() },
  }
}
