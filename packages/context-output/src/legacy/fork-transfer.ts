import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { captureBootstrapPreparationFacts, createLegacyRetentionSelection } from '@i-harness/core-session'
import type { ContextStore } from '../store.ts'
import type { IndexedLegacyContext } from './index-lifecycle.ts'
import type { WorkspaceMutationTurn } from '../workspace-mutation.ts'
import { failuresTogether } from '../workspace-mutation.ts'
import { continueAtomicJson, confirmAtomicJson, ownedMkdir } from '../artifact/io.ts'
import { requireSpace } from '../artifact/quota.ts'
import { appliedFor, canonicalRecord, checkBinding, checkRoot, commitment, count, fields, hash, recordHash, same, sourceHash, streamHash } from './fork-codec.ts'
import { buildPages, walkPages } from './fork-pages.ts'
import { expiryBase, expiredTuple, readSlots, revokedTuple } from './fork-disposition.ts'
import { captureObservation, loadPlan, observedAllowed, prepareObservedIndex, rowCommitment, transferDirectory, verifiedRows } from './observed-read.ts'
import { prepareLegacyIndex } from './fork-index.ts'
import type { LegacyForkCapture, LegacyForkTransferScope, LegacyPreparationRequest, LegacyTransferOutcome, LegacyFacts, LegacyRow, LegacyPage } from './fork-types.ts'

type Scope = { capture?: LegacyForkCapture; invalid: boolean; attempts: Set<Promise<LegacyTransferOutcome>>; count?: number; store?: ContextStore; dispose(): void }
interface Ports {
  strict: boolean; workspaceId: string; quota(): number;
  mutate<T>(context: IndexedLegacyContext, work: (turn: WorkspaceMutationTurn) => Promise<T>): Promise<T>;
  run<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal, context: IndexedLegacyContext) => Promise<T>): Promise<T>;
}
const blocked = (reason: 'unknown' | 'unavailable' | 'conflict' | 'policy'): LegacyTransferOutcome => ({ kind: 'blocked', reason })
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const addSignalListener = EventTarget.prototype.addEventListener, removeSignalListener = EventTarget.prototype.removeEventListener
const aborted = (signal?: AbortSignal): boolean => signal === undefined ? false : Reflect.apply(signalAborted, signal, [])
export function createLegacyForkOwner(ports: Ports) {
  const scopes = new Map<LegacyForkTransferScope, Scope>(), retired = new WeakSet<LegacyForkTransferScope>(); let closed = false
  function register(input: LegacyForkCapture): LegacyForkTransferScope {
    if (closed || !ports.strict) throw Error('Legacy fork requires strict observed recipient mode')
    fields(input, ['invocation', 'sourceSessionId', 'semanticSeedDigest', 'sourceObservationDigest', 'selection', 'target'], ['source', 'signal'])
    if (!hash(input.semanticSeedDigest) || !hash(input.sourceObservationDigest) || typeof input.sourceSessionId !== 'string' || !input.sourceSessionId) throw Error('Invalid legacy capture')
    fields(input.target, ['available', 'assertCurrent', 'sourceId'])
    if (['available', 'assertCurrent', 'sourceId'].some(key => typeof input.target[key as keyof typeof input.target] !== 'function' || types.isProxy(input.target[key as keyof typeof input.target]))) throw Error('Invalid legacy target capability')
    if (input.signal !== undefined) { try { if (types.isProxy(input.signal)) throw Error(); aborted(input.signal) } catch { throw new TypeError('Invalid legacy AbortSignal capability') } }
    fields(input.selection, ['kind'], ['atSeq']); if (input.selection.kind !== 'completed' || input.selection.atSeq !== undefined && !count(input.selection.atSeq)) throw Error('Invalid legacy selection')
    const invocation = captureBootstrapPreparationFacts({ version: 1, invocation: input.invocation, manifestDigest: input.semanticSeedDigest, seedDigest: input.semanticSeedDigest, sourceObservation: { kind: 'none' }, groupCount: 0 }).invocation
    const target = { available: input.target.available.bind(input.target), assertCurrent: input.target.assertCurrent.bind(input.target), sourceId: input.target.sourceId.bind(input.target) }
    let source: LegacyForkCapture['source']
    if (input.source !== undefined) {
      fields(input.source, ['view', 'read', 'assertCurrent'])
      if (typeof input.source.assertCurrent !== 'function' || types.isProxy(input.source.assertCurrent) || !input.source.view || !Array.isArray(input.source.view.events)) throw Error('Invalid legacy source capability')
      source = { view: input.source.view, read: captureObservation(input.source.read), assertCurrent: input.source.assertCurrent.bind(input.source) }
      if (source.read.sessionId !== input.sourceSessionId) throw Error('Legacy source document mismatch')
    }
    const capture: LegacyForkCapture = { invocation, target, sourceSessionId: input.sourceSessionId, semanticSeedDigest: input.semanticSeedDigest, sourceObservationDigest: input.sourceObservationDigest,
      selection: structuredClone(input.selection), ...(source ? { source } : {}), ...(input.signal ? { signal: input.signal } : {}) }
    const token = Object.freeze({}) as LegacyForkTransferScope
    const abort = () => { state.invalid = true }
    const signal = capture.signal
    const state: Scope = { capture, invalid: aborted(signal), attempts: new Set(), count: source?.view.events.length, dispose: () => { if (signal) Reflect.apply(removeSignalListener, signal, ['abort', abort]) } }
    scopes.set(token, state)
    try { if (signal) Reflect.apply(addSignalListener, signal, ['abort', abort, { once: true }]) }
    catch (cause) {
      state.invalid = true; state.capture = undefined
      try { state.dispose(); scopes.delete(token) } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Original legacy listener installation cleanup failed') }
      throw cause
    }
    return token
  }
  function guard(scope: Scope, signal?: AbortSignal, source = false, current = () => true): void {
    try {
      const capture = scope.capture
      if (closed || scope.invalid || !capture || signal?.aborted || aborted(capture.signal) || current() !== true || capture.target.available() !== true) throw Error('Legacy scope unavailable')
      capture.target.assertCurrent()
      if (source) {
        const witness = capture.source
        if (!witness || witness.view.events.length !== scope.count) throw Error('Original legacy source witness unavailable')
        witness.assertCurrent(); witness.read.assertCurrent()
      }
    } catch (cause) { scope.invalid = true; throw cause }
  }
  function factsFor(scope: Scope, request: LegacyPreparationRequest, input: LegacyFacts): LegacyFacts {
    fields(request, ['invocation', 'manifestDigest'])
    const f = captureBootstrapPreparationFacts(input), c = scope.capture!
    if (!same(c.invocation, request.invocation) || !same(f.invocation, c.invocation) || request.manifestDigest !== f.manifestDigest || f.seedDigest !== c.semanticSeedDigest || f.sourceObservation.kind !== 'semantic' || f.sourceObservation.digest !== c.sourceObservationDigest || !f.semantic || !same(f.semantic.selection, c.selection)) throw Error('Legacy B2 preparation facts conflict')
    return f
  }
  function start(token: LegacyForkTransferScope, request: LegacyPreparationRequest, input: LegacyFacts, current: () => boolean, passive: boolean): Promise<LegacyTransferOutcome> {
    const scope = scopes.get(token)
    if (!scope || scope.invalid || !scope.capture || closed) return Promise.resolve(blocked('unavailable'))
    const capture = scope.capture
    let facts: LegacyFacts
    try { facts = factsFor(scope, request, input) } catch { return Promise.resolve(blocked('conflict')) }
    // The original attempt is registered synchronously before its first await.
    const task = ports.run<LegacyTransferOutcome>(capture.signal, async (signal, context) => {
      const { store, lease, index } = context
      const check = () => { index.assertCurrent(); guard(scope, signal, !passive, current) }
      let issued = false
      try {
        check()
        scope.store = store; check()
        const directory = transferDirectory(store, capture.invocation), c = capture
        const targetSourceDigest = sourceHash(c.target.sourceId()); check()
        if (passive) {
          const loaded = await loadPlan(store, { bootstrap: { invocation: c.invocation, manifestDigest: facts.manifestDigest, seedDigest: facts.seedDigest } }, check); check()
          const b = loaded.root.binding
          if (b.targetSourceDigest !== targetSourceDigest || b.sourceSessionId !== c.sourceSessionId || b.sourceObservationDigest !== c.sourceObservationDigest || !same(b.selection, c.selection) || b.turnDomainDigest !== streamHash('ih.legacy-fork.turn-domain.v1', facts.semantic!.turns).digest || b.totalTurns !== facts.semantic!.turns.total || b.unframedPrefix !== facts.semantic!.turns.unframedPrefix) return blocked('conflict')
          await prepareLegacyIndex(context, directory, loaded.root, check, ports.mutate, ports.quota(), facts.groupCount, true); check()
          for await (const _ of verifiedRows(context, loaded.directory, loaded.root, check, facts)) { check() }
          check(); return { kind: 'confirmed' }
        }
        const source = c.source!, selection = createLegacyRetentionSelection(source.view, c.selection); check()
        if (selection.kind !== 'selected') return blocked('unavailable')
        if (selection.turnDomainDigest !== streamHash('ih.legacy-fork.turn-domain.v1', facts.semantic!.turns).digest || selection.totalTurns !== facts.semantic!.turns.total || selection.unframedPrefix !== facts.semantic!.turns.unframedPrefix) return blocked('conflict')
        await prepareObservedIndex(context, source.read, check, ports.mutate, ports.quota()); check()
        const binding = checkBinding({ workspaceId: ports.workspaceId, invocation: c.invocation, manifestDigest: facts.manifestDigest, sourceSessionId: c.sourceSessionId,
          targetSessionId: c.invocation.targetSessionId, targetDocumentId: c.invocation.targetSessionId, semanticSeedDigest: c.semanticSeedDigest, sourceObservationDigest: c.sourceObservationDigest,
          selection: c.selection, targetSourceDigest, turnDomainDigest: selection.turnDomainDigest, totalTurns: selection.totalTurns, unframedPrefix: selection.unframedPrefix })
        const bindingDigest = recordHash('binding', binding)
        async function publish(name: string, value: unknown): Promise<void> {
          value = canonicalRecord(value)
          check(); await ports.mutate(context, async turn => {
            turn.assertCurrent(); check()
            await ownedMkdir(store.directory, resolve(directory, 'pages'), check)
            if (name.startsWith('pages/')) { await store.stageLegacyPage(turn, lease, index,  bindingDigest, name.slice(6), value as LegacyPage, ports.quota()); check() }
            const path = resolve(directory, name), confirmed = await confirmAtomicJson(store.directory, path, value, store.retireLegacyFile); check()
            if (confirmed.kind === 'confirmed') return
            if (confirmed.kind === 'conflict') throw Error('Legacy original publication conflict')
            const bytes = Buffer.from(JSON.stringify(value)), pending = path + '.' + createHash('sha256').update(bytes).digest('hex') + '.pending'
            let retained = 0
            try { retained = (await stat(pending)).size } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            check(); await requireSpace(store.directory, ports.quota(), Math.max(0, bytes.length - retained)); check()
            issued = true
            const outcome = await continueAtomicJson(store.directory, path, value, () => { check(); return true }, store.retireLegacyFile); check()
            if (outcome.kind !== 'confirmed') throw Error('Legacy original publication ' + outcome.kind)
          }); check()
        }
        // Exact actual manifest binding precedes every page. Warm retries only
        // confirm the same original prefix, never replace a foreign sibling.
        await publish('binding.json', { version: 1, kind: 'legacy-fork-binding', binding })
        async function qualify(row: LegacyRow): Promise<void> {
          check(); const actual = await store.canonicalRef(rowCommitment(row), c.sourceSessionId); check()
          if (!await observedAllowed(context, actual, source.read, check)) throw Error('Legacy source observation unavailable'); check()
        }
        async function* rows(): AsyncGenerator<LegacyRow> {
          // Inherited seed coordinates precede local journal coordinates;
          // within a seed anchor the immediate parent's row order is stable.
          if (source.read.bootstrap) {
            const parent = await loadPlan(store, source.read, check); check(); let ordinal = 0
            for await (const old of verifiedRows(context, parent.directory, parent.root, check)) {
              const position = ordinal++, included = selection.kind === 'selected' ? selection.inherited(old.extent, old.anchor) : { kind: 'omitted' as const }
              if (included.kind === 'omitted') continue
              if (included.kind !== 'included') throw Error('Inherited legacy anchor unsupported')
              const row: LegacyRow = { ...rowCommitment(old), extent: included.extent, anchor: included.anchor, original: old.original,
                via: { sessionId: c.sourceSessionId, operationId: parent.root.binding.invocation.operationId, manifestDigest: parent.root.binding.manifestDigest, planDigest: recordHash('plan', parent.root), rowOrdinal: position } }
              await qualify(row); check(); yield row
            }
          }
          for (const local of selection.kind === 'selected' ? selection.local() : []) {
            check(); const row: LegacyRow = { ...commitment(local.ref), extent: local.extent, anchor: local.anchor, original: { sessionId: c.sourceSessionId, ...local.original } }
            await qualify(row); check(); yield row
          }
        }
        const graph = await buildPages(binding, rows(), (name, page) => publish('pages/' + name, page)), counts = store.legacyCounts(index, bindingDigest)
        if (counts.observations !== graph.observationCount) throw Error('Legacy derived EOF mismatch')
        const root = checkRoot({ version: 1, kind: 'legacy-fork-plan', binding, ...graph, distinctRefCount: counts.refs })
        await publish('plan.json', root); check()
        // Validate the complete original graph and live canonical metadata before
        // funding any target owner, then fund every slot/reserve before additions.
        await ports.mutate(context, async turn => {
          check(); await store.confirmLegacyIndex(turn, lease, index,  root, ports.quota()); check()
          await store.fundLegacyBatch(turn, lease, index, ports.quota(), root, facts.groupCount, check, qualify)
          check()
        }); check()
        let ordinal = 0
          for await (const row of walkPages(directory, root, check, facts.groupCount, store.retireLegacyFile)) {
            const position = ordinal++, tuple = rowCommitment(row); if (store.legacyFirst(index, bindingDigest, row.refId) !== position) continue
            await qualify(row); check()
            await ports.mutate(context, async turn => {
              check(); await qualify(row); check()
              if (await readSlots(store.directory, resolve(directory, 'revoke'), revokedTuple(root), store.retireLegacyFile) !== 'live' || await readSlots(store.directory, expiryBase(store.directory, tuple), expiredTuple(store.workspaceId, tuple), store.retireLegacyFile) !== 'live') throw Error('Legacy disposition unavailable')
              check(); issued = true; await store.mergeLegacyOwner(turn, lease,  row.refId, binding.targetSessionId, binding.invocation.operationId, check); check()
            }); check()
          }
        await publish('applied.json', appliedFor(root)); check()
        const loaded = await loadPlan(store, { bootstrap: { invocation: c.invocation, manifestDigest: facts.manifestDigest, seedDigest: facts.seedDigest } }, check); check()
        for await (const _ of verifiedRows(context, directory, loaded.root, check, facts)) { check() }
        return { kind: 'confirmed' }
      } catch (cause) {
        if (scope.invalid || signal.aborted) return blocked(issued ? 'unknown' : 'policy')
        const text = cause instanceof Error ? cause.message : String(cause)
        return blocked(/conflict|Invalid/.test(text) ? 'conflict' : issued ? 'unknown' : 'unavailable')
      }
    }).catch(() => blocked('unavailable'))
    scope.attempts.add(task); void task.finally(() => scope.attempts.delete(task))
    return task
  }
  async function closeScope(token: LegacyForkTransferScope): Promise<void> {
    const scope = scopes.get(token); if (!scope) { if (retired.has(token)) return; throw Error('Foreign legacy scope') }
    scope.invalid = true
    const failures: unknown[] = []
    try { scope.dispose(); scope.dispose = () => {} } catch (failure) { failures.push(failure) }
    const settled = await Promise.allSettled([...scope.attempts])
    failures.push(...settled.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []))
    scope.capture = undefined
    try { await scope.store?.joinLegacyFiles() } catch (failure) { failures.push(failure) }
    failuresTogether(failures, 'Original legacy scope cleanup failed')
    scopes.delete(token); retired.add(token)
  }
  return {
    register, confirm: (scope: LegacyForkTransferScope, request: LegacyPreparationRequest, current: () => boolean, facts: LegacyFacts) => start(scope, request, facts, current, false),
    reconcile: (scope: LegacyForkTransferScope, request: LegacyPreparationRequest, facts: LegacyFacts) => start(scope, request, facts, () => true, true), closeScope,
    retire(sessionId?: string) { for (const scope of scopes.values()) if (sessionId === undefined || scope.capture?.sourceSessionId === sessionId || scope.capture?.invocation.targetSessionId === sessionId) scope.invalid = true },
    async close() { closed = true; const settled = await Promise.allSettled([...scopes.keys()].map(closeScope)); failuresTogether(settled.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []), 'Original legacy scopes failed to close') },
  }
}
