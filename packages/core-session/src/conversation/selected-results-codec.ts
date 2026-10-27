import type { ResultsSummaryV1, SelectedResultPageV1 } from './selected-results-types.ts'
import type { SemanticSeedV3 } from './seed-types.ts'
import { seedCount, seedData, seedDigest, seedFields, seedId, seedInvalid, validateTurnExtent } from './seed-codec.ts'
import { seedHash } from './seed-digest.ts'
import { validManagedArtifactRef } from '../results/validate.ts'
import { legacyResultMetadata } from './history/result-metadata.ts'
import { canonicalJsonData } from '../serialization/json-data.ts'
import { itemOriginSlots, resultOriginAddresses } from './seed-origins.ts'

export const selectedResultRecord = (page: SelectedResultPageV1) => ({ type: 'conversation/seed-results' as const, version: 1 as const, seq: 1 + page.ordinal, manifestSeq: 0 as const, ordinal: page.ordinal, page })
export const selectedResultPageBytes = (page: SelectedResultPageV1): number => Buffer.byteLength(canonicalJsonData(selectedResultRecord(page)))
export function selectedResultsDigest(rows: number, pages: readonly SelectedResultPageV1[]): string {
  let previous = seedHash('ih.selected-results.start.v1', { version: 1, rows, pages: pages.length })
  for (const page of pages) previous = seedHash('ih.selected-results.page.v1', { previous, page })
  return seedHash('ih.selected-results.end.v1', { previous, rows, pages: pages.length })
}
export function validateResultsSummary(value: unknown): asserts value is ResultsSummaryV1 {
  seedData(value); seedFields(value, ['version', 'rows', 'pages', 'digest'])
  const summary = value as ResultsSummaryV1
  if (summary.version !== 1 || !seedCount(summary.rows) || !seedCount(summary.pages) || summary.rows > 10_000 || summary.pages > summary.rows || !seedDigest(summary.digest)
    || (summary.rows === 0) !== (summary.pages === 0) || summary.rows === 0 && summary.digest !== selectedResultsDigest(0, [])) seedInvalid()
}
export function validateSelectedResultPage(page: SelectedResultPageV1, total: number, origins: number): void {
  seedData(page); seedFields(page, ['version', 'ordinal', 'firstRow', 'extent', 'rows'])
  if (page.version !== 1 || !seedCount(page.ordinal) || !seedCount(page.firstRow) || !Array.isArray(page.rows) || !page.rows.length || page.rows.length > 100 || selectedResultPageBytes(page) > 65_536) seedInvalid()
  validateTurnExtent(page.extent, total)
  const address = (value: import('./seed-types.ts').SeedOriginAddress) => {
    seedFields(value, ['origin', 'seq', 'part'])
    if (!seedCount(value.origin) || value.origin >= origins || !seedCount(value.seq) || typeof value.part !== 'string' || !value.part.length || Buffer.byteLength(value.part) > 64) seedInvalid()
  }
  for (const [index, row] of page.rows.entries()) {
    seedFields(row, ['ordinal', 'original', 'extent', 'basis', 'branchEvidence', 'protocol', 'ref', ...(row.protocol === 'managed' ? ['use'] : [])])
    if (row.ordinal !== page.firstRow + index || !Number.isSafeInteger(row.ordinal) || canonicalJsonData(row.extent) !== canonicalJsonData(page.extent)) seedInvalid()
    const original = row.original
    seedFields(original, ['kind', 'sessionId', 'seq', 'event', 'slot', ...(original.kind === 'seed-use' ? ['item', 'result'] : [])])
    if (!seedId(original.sessionId) || !seedCount(original.seq)) seedInvalid()
    if (original.kind === 'seed-use') {
      if (original.event !== 'conversation/seed-group' || !seedCount(original.item) || !seedCount(original.result) || !['sourceRetention.artifact', 'dependencies.artifact'].includes(original.slot) || row.protocol !== 'managed') seedInvalid()
    } else if (original.kind !== 'local' || (row.protocol === 'legacy' ? original.event !== 'context/result-ref' || original.slot !== 'ref'
      : original.event === 'context/result-ref' || !['tool/result', 'code/result', 'code/output', 'subagent/end', 'job/status'].includes(original.event)
        || !(original.event === 'job/status' ? ['job.result.envelope.retention.ref', 'job.result.envelope.dependencies.ref'] : ['envelope.retention.ref', 'envelope.dependencies.ref']).includes(original.slot))) seedInvalid()
    if (row.protocol === 'managed') {
      if (!validManagedArtifactRef(row.ref)) seedInvalid()
      seedFields(row.use, row.use.kind === 'result' ? ['kind'] : ['kind', 'count'])
      if (row.use.kind !== 'result' && (row.use.kind !== 'dependency-catalog' || !seedCount(row.use.count) || !row.use.count || row.ref.codec !== 'json-utf8-v1')) seedInvalid()
      const catalog = original.slot === 'dependencies.artifact' || original.slot.endsWith('dependencies.ref')
      if (catalog !== (row.use.kind === 'dependency-catalog')) seedInvalid()
    } else if (row.protocol !== 'legacy') seedInvalid()
    else if (canonicalJsonData(legacyResultMetadata(row.ref)) !== canonicalJsonData(row.ref)) seedInvalid()
    const basis = row.basis
    seedFields(basis, ['kind', ...(basis.kind === 'inherited' ? ['parentSeedDigest', 'parentResultsDigest', 'row'] : ['unit', ...(basis.kind === 'consumed-closed' ? ['consumedAt', 'latestConsumption'] : basis.kind === 'standalone-native' ? ['completedCell'] : [])])])
    if (basis.kind === 'inherited') { if (!seedDigest(basis.parentSeedDigest) || !seedDigest(basis.parentResultsDigest) || !seedCount(basis.row)) seedInvalid() }
    else {
      if (!['selected-observation', 'consumed-closed', 'standalone-native'].includes(basis.kind)) seedInvalid()
      seedFields(basis.unit, ['at', 'closedAt', 'kind'])
      if (!['exchange', 'code-cell', 'job', 'subagent'].includes(basis.unit.kind)) seedInvalid()
      if (basis.unit.at.origin !== basis.unit.closedAt.origin || basis.unit.at.seq > basis.unit.closedAt.seq) seedInvalid()
      if (basis.kind === 'consumed-closed' && (basis.consumedAt.origin !== basis.unit.at.origin || basis.latestConsumption.origin !== basis.consumedAt.origin || basis.consumedAt.seq < basis.unit.closedAt.seq || basis.latestConsumption.seq < basis.consumedAt.seq)) seedInvalid()
      if (basis.kind === 'standalone-native' && (basis.unit.kind !== 'code-cell' || canonicalJsonData(basis.completedCell) !== canonicalJsonData(basis.unit.closedAt))) seedInvalid()
    }
    if (!Array.isArray(row.branchEvidence) || !row.branchEvidence.length || row.branchEvidence.length > 16) seedInvalid()
    for (const at of resultOriginAddresses(row)) address(at)
  }
}
export function validateSelectedResultsTable(seed: SemanticSeedV3, partial = false): void {
  seedFields(seed.results, ['summary', 'pages']); validateResultsSummary(seed.results.summary)
  const { summary, pages } = seed.results
  if (!Array.isArray(pages) || pages.length > summary.pages || !partial && pages.length !== summary.pages) seedInvalid()
  let rows = 0, bytes = 0
  for (const [ordinal, page] of pages.entries()) {
    validateSelectedResultPage(page, seed.turns.total, seed.origins.length)
    if (page.ordinal !== ordinal || page.firstRow !== rows) seedInvalid()
    const prior = pages[ordinal - 1]
    if (prior && canonicalJsonData(prior.extent) === canonicalJsonData(page.extent) && prior.rows.length < 100
      && selectedResultPageBytes({ ...prior, rows: [...prior.rows, page.rows[0]!] }) <= 65_536) seedInvalid()
    rows += page.rows.length; bytes += selectedResultPageBytes(page)
  }
  if (rows > summary.rows || bytes > 8_388_608 || !partial && (rows !== summary.rows || selectedResultsDigest(rows, pages) !== summary.digest)) seedInvalid()
  if (partial) return
  const referenced = new Set<number>()
  for (const group of seed.groups) for (const item of group.items) for (const slot of itemOriginSlots(item)) referenced.add(slot)
  for (const omission of seed.omissions) for (const at of omission.source) referenced.add(at.origin)
  for (const artifact of seed.artifacts) for (const at of artifact.origins) referenced.add(at.origin)
  for (const page of pages) for (const row of page.rows) for (const at of resultOriginAddresses(row)) referenced.add(at.origin)
  let previous: string | undefined
  for (let slot = 1; slot < seed.origins.length; slot++) {
    const key = canonicalJsonData(seed.origins[slot])
    if (!referenced.has(slot) || previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(key)) >= 0) seedInvalid()
    previous = key
  }
}
