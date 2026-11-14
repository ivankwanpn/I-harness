import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFactBatch, encodeFactBatch, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { codecSeed, codecPage, codecRow, sealCodecSeed } from '../../../core-session/test/fixtures/selected-results.ts'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../../../session-persistence/src/selected-results-fork-contract.ts'
import { compileSelectedResultsSemanticSeed } from '../../../session-persistence/src/semantic-seed.ts'
import { buildSelectedResultsHeader } from '../../../session-persistence/src/coordinator/selected-results-header.ts'
import { createJsonlTaskTransitionCoordinator } from '../../../session-persistence-jsonl/src/task-document-factory.ts'
import { selectedBootstrapPaths } from '../../../session-persistence-jsonl/src/backend/selected-results-route-path.ts'
import { taskDocumentStorageContract } from '../../../subagent/src/task/storage-contract.ts'
import { createContextOutputService } from '../../src/service.ts'
import { ContextStore } from '../../src/store.ts'
import { appliedFor, canonicalRecord, checkBinding, checkRoot, commitment, sourceHash, streamHash } from '../../src/legacy/fork-codec.ts'
import { buildPages } from '../../src/legacy/fork-pages.ts'
import { expiryBase, expiredTuple, fundSlots, revokedTuple } from '../../src/legacy/fork-disposition.ts'
import { transferDirectory } from '../../src/legacy/observed-read.ts'
import type { LegacyRowV2 } from '../../src/legacy/fork-types.ts'
import type { BootstrapProjectIntent } from '../../../session-persistence/src/coordinator/bootstrap-intent.ts'

export async function coldLegacyFixture(empty = false, project: BootstrapProjectIntent = { kind: 'unmanaged' }) {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'cold-legacy-')), sourceId = 'current-target-policy'
  const producer = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  let ref: Awaited<ReturnType<typeof producer.capture>>
  try {
    ref = await producer.capture({ sessionId: 'source', callId: 'legacy', label: 'legacy', text: 'original legacy bytes', complete: true, source: { sourceId } })
    if (ref) await producer.grant({ sessionId: 'source' }, [ref.id], 'target')
  } finally {
    await producer.close()
  }
  if (!ref) throw Error('Original capture unavailable')
  const row = codecRow(); row.protocol = 'legacy'; delete row.use; row.ref = ref; row.original = { kind: 'local', sessionId: 'source', seq: 4, event: 'context/result-ref', slot: 'ref' }
  const exported = codecSeed('public-completed', empty ? [] : [codecPage([row])])
  exported.seed.groups = [{ extent: { kind: 'framed', first: 1, last: 1 }, items: [{ kind: 'summary', scope: 'turn', extent: { kind: 'framed', first: 1, last: 1 }, origins: [{ origin: 0, seq: 1, part: 'message' }], sourceProvenance: [{ origin: 0, kind: 'summary', authority: 'derived', scope: 'turn' }], messages: [{ role: 'user', content: 'summary' }] }] }]
  exported.seed.passive.codeStore.groups = [0]
  const sealed = sealCodecSeed(exported.seed), seed = compileSelectedResultsSemanticSeed(sealed)
  const core = readSelectedResultsCore({ version: 2, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {}, results: 'selected-results-v1' })
  const { intent, requestDigest } = createSelectedResultsIntent(core, project), invocation = { version: 1 as const, operationId: 'cold-legacy', targetSessionId: 'target', createdAt: '2026-11-01T00:00:00.000Z', requestDigest }
  const request = { invocation, core, requestIntent: intent }, route = { protocol: 'public-results-v1' as const, request }
  const built = buildSelectedResultsHeader({ invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'source' }, seed }, { version: 1, kind: 'semantic-bootstrap-selected-results-capture', request })
  const meta = JSON.parse(built.headerBytes), first = encodeFactBatch('bootstrap:cold-legacy:seed', meta.journal.legacyPrefixDigest, seed.records)
  const complete = encodeFactBatch('bootstrap:cold-legacy:complete', decodeFactBatch(first.bytes).prefixDigest, [{ type: 'session/bootstrap', version: 1, seq: seed.records.length, operationId: invocation.operationId, manifestDigest: meta.semanticSeed.manifestDigest, dependencyClosureDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, seedLength: seed.records.length }])
  const path = join(root, 'target.jsonl'); await writeFile(path, Buffer.concat([Buffer.from(built.headerBytes), Buffer.from(first.bytes), Buffer.from(complete.bytes)])); await writeFile(selectedBootstrapPaths(path, route).stage, built.stageBytes)
  await writeFile(join(root, 'task-target.doc.jsonl'), JSON.stringify(taskDocumentStorageContract.empty()) + '\n')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const store = new ContextStore(root, 'w'), directory = transferDirectory(store, invocation)
  const binding = checkBinding({ workspaceId: 'w', invocation, manifestDigest: meta.semanticSeed.manifestDigest, sourceSessionId: 'source', targetSessionId: 'target', targetDocumentId: 'target', semanticSeedDigest: seed.digest, sourceObservationDigest: sealed.sourceObservationDigest, selection: { kind: 'completed' }, targetSourceDigest: sourceHash(sourceId), turnDomainDigest: streamHash('ih.legacy-fork.turn-domain.v1', sealed.seed.turns).digest, totalTurns: 2, unframedPrefix: false, selectedResults: meta.semanticSeed.results }, 2)
  const rows: LegacyRowV2[] = empty ? [] : [{ ...commitment(ref), extent: row.extent, original: { sessionId: 'source', seq: 4, part: 'context/result-ref.ref' }, anchor: { kind: 'seed-result', manifestSeq: 0, pageOrdinal: 0, rowOrdinal: 0 } }]
  await mkdir(join(directory, 'pages'), { recursive: true })
  async function* values() { yield* rows }
  const graph = await buildPages(binding, values(), (name, page) => writeFile(join(directory, 'pages', name), JSON.stringify(canonicalRecord(page))), 2), plan = checkRoot({ version: 2, kind: 'legacy-fork-plan', binding, ...graph, distinctRefCount: rows.length })
  for (const [name, value] of Object.entries({ 'binding.json': { version: 2, kind: 'legacy-fork-binding', binding }, 'plan.json': plan, 'applied.json': appliedFor(plan) })) await writeFile(join(directory, name), JSON.stringify(canonicalRecord(value)))
  await fundSlots(store.directory, join(directory, 'revoke'), revokedTuple(plan), 10_000_000, () => {})
  await fundSlots(store.directory, expiryBase(store.directory, commitment(ref)), expiredTuple('w', commitment(ref)), 10_000_000, () => {})
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  return { root, sourceId, service, coordinator, route, ref, directory, async close() { await coordinator.close(); await service.close() } }
}
