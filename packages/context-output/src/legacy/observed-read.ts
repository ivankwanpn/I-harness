import { resolve } from 'node:path'
import { types } from 'node:util'
import { captureBootstrapPreparationFacts } from '@i-harness/core-session'
import type { ContextStore } from '../store.ts'
import type { IndexedLegacyContext } from './index-lifecycle.ts'
import { boundedJson, confirmAtomicJson, ownedPath } from '../artifact/io.ts'
import { appliedFor, canonicalRecord, checkRoot, commitment, fields, recordHash, same, sourceHash } from './fork-codec.ts'
import { expiryBase, expiredTuple, readSlots, revokedTuple } from './fork-disposition.ts'
import { walkPages, rowProof } from './fork-pages.ts'
import { prepareLegacyIndex, verifyPageInventory, type LegacyIndexMutation } from './fork-index.ts'
import type { LegacyCommitment, LegacyReadObservation, LegacyRoot, LegacyRow, LegacyFacts } from './fork-types.ts'
import type { ContextResultRef } from '../types.ts'

export const transferDirectory = (store: ContextStore, invocation: LegacyRoot['binding']['invocation']) => resolve(store.directory, 'legacy-fork-v1', recordHash('binding', invocation))
export function captureObservation(input: LegacyReadObservation): LegacyReadObservation {
  fields(input, ['sessionId', 'sourceId', 'assertCurrent', 'localVisible', 'anchorVisible'], ['bootstrap'])
  if (typeof input.sessionId !== 'string' || !input.sessionId || typeof input.sourceId !== 'string' || !input.sourceId || ['assertCurrent', 'localVisible', 'anchorVisible'].some(key => typeof input[key as keyof LegacyReadObservation] !== 'function' || types.isProxy(input[key as keyof LegacyReadObservation]))) throw Error('Invalid legacy observation')
  const assertCurrent = input.assertCurrent.bind(input), localVisible = input.localVisible.bind(input), anchorVisible = input.anchorVisible.bind(input)
  let bootstrap: LegacyReadObservation['bootstrap']
  if (input.bootstrap !== undefined) {
    fields(input.bootstrap, ['invocation', 'manifestDigest', 'seedDigest'])
    const f = captureBootstrapPreparationFacts({ version: 1, ...input.bootstrap, sourceObservation: { kind: 'none' }, groupCount: 0 })
    bootstrap = { invocation: f.invocation, manifestDigest: f.manifestDigest, seedDigest: f.seedDigest }
  }
  return { sessionId: input.sessionId, sourceId: input.sourceId, assertCurrent, localVisible, anchorVisible, ...(bootstrap ? { bootstrap } : {}) }
}
export async function loadPlan(store: ContextStore, observation: Pick<LegacyReadObservation, 'bootstrap'>, guard: () => void): Promise<{ directory: string; root: LegacyRoot }> {
  if (!observation.bootstrap) throw Error('Legacy bootstrap observation unavailable')
  const directory = transferDirectory(store, observation.bootstrap.invocation), path = resolve(directory, 'plan.json')
  await ownedPath(store.directory, path); guard()
  const root = checkRoot(await boundedJson(path, 65536, store.retireLegacyFile)); guard()
  if (root.binding.workspaceId !== store.workspaceId || !same(root.binding.invocation, observation.bootstrap.invocation) || root.binding.manifestDigest !== observation.bootstrap.manifestDigest || root.binding.semanticSeedDigest !== observation.bootstrap.seedDigest) throw Error('Legacy original binding conflict')
  const bindingRecord = canonicalRecord({ version: 1, kind: 'legacy-fork-binding', binding: root.binding })
  if ((await confirmAtomicJson(store.directory, resolve(directory, 'binding.json'), bindingRecord, store.retireLegacyFile)).kind !== 'confirmed') throw Error('Legacy binding unconfirmed'); guard()
  if ((await confirmAtomicJson(store.directory, path, root, store.retireLegacyFile)).kind !== 'confirmed') throw Error('Legacy plan unconfirmed'); guard()
  if ((await confirmAtomicJson(store.directory, resolve(directory, 'applied.json'), appliedFor(root), store.retireLegacyFile)).kind !== 'confirmed') throw Error('Legacy application unconfirmed'); guard()
  if (await readSlots(store.directory, resolve(directory, 'revoke'), revokedTuple(root), store.retireLegacyFile) !== 'live') throw Error('Legacy grant revoked or unknown'); guard()
  return { directory, root }
}
/** Complete graph validation and canonical membership, independent of SQLite
 * hints. Expiry may acknowledge historical application, never live retrieval. */
export async function* verifiedRows(context: IndexedLegacyContext, directory: string, root: LegacyRoot, guard: () => void, facts?: LegacyFacts): AsyncGenerator<LegacyRow> {
  const { store, index } = context
  index.assertCurrent()
  const binding = recordHash('binding', root.binding), counts = store.legacyCounts(index, binding)
  if (counts.observations !== root.observationCount || counts.refs !== root.distinctRefCount) throw Error('Legacy index preparation required')
  let ordinal = 0
    for await (const row of walkPages(directory, root, guard, facts?.groupCount, store.retireLegacyFile)) {
      if (!same(store.legacyHint(index, binding, ordinal), row)) throw Error('Legacy derived row conflict')
      const c = { refId: row.refId, revision: row.revision, metadataDigest: row.metadataDigest, metadataEncodedBytes: row.metadataEncodedBytes, expiresAt: row.expiresAt }
      if (store.legacyFirst(index, binding, row.refId) === ordinal) {
        const expiry = await readSlots(store.directory, expiryBase(store.directory, c), expiredTuple(store.workspaceId, c), store.retireLegacyFile); guard()
        if (expiry !== 'terminal') {
          if (expiry !== 'live') throw Error('Legacy expiry unknown')
          await store.canonicalRef(c, root.binding.targetSessionId); guard()
        }
      }
      ordinal++; yield row
    }
}
export async function prepareObservedIndex(context: IndexedLegacyContext, observation: LegacyReadObservation, guard: () => void, mutate: LegacyIndexMutation, quota: number): Promise<void> {
  const { store, index } = context
  index.assertCurrent()
  if (!observation.bootstrap) return
  const { directory, root } = await loadPlan(store, observation, guard)
  if (root.binding.targetSessionId !== observation.sessionId || root.binding.targetSourceDigest !== sourceHash(observation.sourceId)) throw Error('Legacy target observation conflict')
  await prepareLegacyIndex(context, directory, root, guard, mutate, quota)
}
export async function observedAllowed(context: IndexedLegacyContext, ref: ContextResultRef, observation: LegacyReadObservation, guard: () => void): Promise<boolean> {
  const { store, index } = context
  index.assertCurrent()
  guard(); if (observation.sessionId === '' || ref.workspaceId !== store.workspaceId) return false
  const c = commitment(ref)
  const sourcePolicy = () => !ref.source || ref.source.sourceId === observation.sourceId
  if (observation.localVisible(c) === true) { guard(); await store.canonicalRef(c, observation.sessionId); guard(); return sourcePolicy() && observation.localVisible(c) === true }
  if (!observation.bootstrap) return false
  try {
    const { directory, root } = await loadPlan(store, observation, guard)
    if (root.binding.targetSessionId !== observation.sessionId || root.binding.targetSourceDigest !== sourceHash(observation.sourceId) || !sourcePolicy()) return false
    if (!store.legacyReady(index, root)) return false
    await verifyPageInventory(context, directory, root, guard)
    let match: LegacyRow | undefined
    for (const hint of store.legacyHints(index, recordHash('binding', root.binding), ref.id)) {
      // Untrusted derived metadata may reject candidates cheaply; it never
      // authorizes one. Every accepted hint still needs the actual page proof.
      if (!same(c, rowCommitment(hint.row)) || observation.anchorVisible(hint.row.anchor, hint.row.extent) !== true) continue
      const row = await rowProof(directory, root, hint.ordinal, guard, store.retireLegacyFile)
      if (!same(row, hint.row)) throw Error('Legacy proof hint conflict')
      if (same(c, rowCommitment(row)) && observation.anchorVisible(row.anchor, row.extent) === true) { match = row; break }
    }
    guard()
    if (await readSlots(store.directory, expiryBase(store.directory, c), expiredTuple(store.workspaceId, c), store.retireLegacyFile) !== 'live') return false
    guard(); await store.canonicalRef(c, observation.sessionId); guard()
    return match !== undefined && observation.anchorVisible(match.anchor, match.extent) === true
  } catch (failure) {
    try { index.assertCurrent() } catch { throw failure }
    if ((failure as { code?: string })?.code === 'CONTEXT_INDEX_UNAVAILABLE') throw failure
    if (failure instanceof Error && /derived|hint conflict/i.test(failure.message)) store.rejectIndex(failure)
    guard(); return false
  }
}
export const rowCommitment = (row: LegacyCommitment): LegacyCommitment => ({ refId: row.refId, revision: row.revision, metadataDigest: row.metadataDigest, metadataEncodedBytes: row.metadataEncodedBytes, expiresAt: row.expiresAt })
