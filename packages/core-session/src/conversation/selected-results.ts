import type { CompletedPassiveContext } from './passive-seed-context.ts'
import { isOriginalCompletedPassiveContext } from './passive-seed-context.ts'
import { isManagedFactOwner, isManagedResultSource } from '../managed/view.ts'
import type { HeldInheritedResultMetadata, ResultClassification, SelectedResultPageV1, SelectedResultRow, SelectedResultsOutcome } from './selected-results-types.ts'
import { createResultResourceLedger } from './history/result-resources.ts'
import { canonicalJsonData } from '../serialization/json-data.ts'
import { seedHash } from './seed-digest.ts'
import { resultAt } from './history/result-units.ts'
import { iterateHeldInheritedResultMetadata } from './history/result-inherited.ts'

// Explicit bounded metadata diagnostics. No payload is part of these budgets.
export const SELECTED_RESULT_METADATA_LIMITS = Object.freeze({ rows: 10_000, bytes: 8_388_608, pageRows: 100, pageBytes: 65_536 })
// Reserve the specified complete record overhead without emitting a journal
// event or enabling any codec. Durable V3 compilation remains a later task.
const pageBytes = (page: SelectedResultPageV1) => Buffer.byteLength(canonicalJsonData({ type: 'conversation/seed-results', version: 1,
  seq: 1 + page.ordinal, manifestSeq: 0, ordinal: page.ordinal, page }))
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value) }
  return value
}
export async function projectSelectedResults(context: CompletedPassiveContext, inherited: HeldInheritedResultMetadata): Promise<SelectedResultsOutcome> {
  let changed = false
  const assertCurrent = () => {
    try { context.owner.assertCurrent(); inherited.assertCurrent() }
    catch (cause) { changed = true; throw cause }
  }
  try {
    assertCurrent()
    if (!isOriginalCompletedPassiveContext(context) || context.kind !== 'completed-passive' || context.source.view !== context.owner.view || !isManagedFactOwner(context.owner.view, context.owner.factOwner)) return { kind: 'refused', reason: 'unsupported-history' }
    if (!isManagedResultSource(context.owner.view, context.owner.factOwner, context.owner.sourceSessionId)) return { kind: 'refused', reason: 'ambiguous' }
    const ledger = createResultResourceLedger(context), classifications: ResultClassification[] = [], inheritedRows = new Set<SelectedResultRow>()
    let rows: SelectedResultRow[] = []
    let bytes = 0
    const record = (classification: ResultClassification, inheritedRow = false) => {
      if (classification.kind === 'refused') return classification
      const snapshot = immutable(structuredClone(classification))
      bytes += Buffer.byteLength(canonicalJsonData(snapshot))
      if (classifications.length >= SELECTED_RESULT_METADATA_LIMITS.rows || bytes > SELECTED_RESULT_METADATA_LIMITS.bytes) return { kind: 'refused' as const, reason: 'metadata-limit' as const }
      classifications.push(snapshot)
      if (snapshot.kind === 'included') {
        const row = immutable({ ...snapshot.row, ordinal: rows.length }) as SelectedResultRow
        rows.push(row); if (inheritedRow || row.original.kind === 'seed-use') inheritedRows.add(row)
      }
    }
    // No consumer can obtain a prefix before all refusal/ambiguity guards pass.
    for (const declaration of ledger.declarations()) {
      assertCurrent()
      const refusal = record(ledger.classify(declaration)); if (refusal) return refusal
    }
    assertCurrent()
    for await (const value of iterateHeldInheritedResultMetadata(inherited, assertCurrent)) {
      const bound = ledger.extentGuard(value.extent) ?? ledger.inheritedCutGuard(value.extent)
      if (bound) { const refusal = record(bound); if (refusal) return refusal; continue }
      const anchorIndex = value.anchor.kind === 'manifest' ? 0 : value.anchor.ordinal + 1
      const anchor = context.source.facts[anchorIndex]
      if (!anchor || (value.anchor.kind === 'manifest' ? anchor.type !== 'conversation/seed-manifest' : anchor.type !== 'conversation/seed-group')) return { kind: 'refused', reason: 'unsupported-history' }
      if (anchorIndex >= ledger.upper) { const refusal = record({ kind: 'excluded', reason: 'future' }); if (refusal) return refusal; continue }
      if (!ledger.visibility.branch(anchor!)) { const refusal = record({ kind: 'excluded', reason: 'rewound' }); if (refusal) return refusal; continue }
      if (ledger.visibility.shadowed(anchor!)) return { kind: 'refused', reason: 'unsupported-history' }
      if (value.anchor.kind === 'seed-group' && (anchor.seedExtent?.kind !== 'framed' || value.extent.kind !== 'framed' || value.extent.first < anchor.seedExtent.first || value.extent.last > anchor.seedExtent.last)) return { kind: 'refused', reason: 'unsupported-history' }
      if (context.selected.inheritedOmissions.some(({ omission }) => omission.extent.kind === 'unframed' ? value.extent.kind === 'unframed'
        : value.extent.kind === 'framed' && omission.extent.first <= value.extent.last && omission.extent.last >= value.extent.first)) return { kind: 'refused', reason: 'unsupported-history' }
      // Old-plan membership must retain its actual selected anchor. Consumed V1
      // inheritance without such proof remains unavailable until a new format.
      const matches = context.selected.groups.filter(group => group.items.some(item => item.sources.some(source => source.eventIndex === anchorIndex)))
      if (value.anchor.kind === 'seed-group' && matches.length !== 1 || value.anchor.kind === 'manifest' && (value.extent.kind !== 'unframed' || !context.selected.turns.unframedPrefix)) return { kind: 'refused', reason: 'unsupported-history' }
      const at = resultAt(anchor!, value.anchor.kind === 'manifest' ? 'manifest' : 'group')
      const refusal = record({ kind: 'included', row: { protocol: 'legacy', ref: value.ref, original: value.original, extent: context.selected.rebase(value.extent), basis: { kind: 'selected-observation', unit: { kind: 'exchange', at, closedAt: at } }, branchEvidence: [at] } }, true)
      if (refusal) return refusal
    }
    assertCurrent()
    rows = [...rows.filter(row => inheritedRows.has(row)), ...rows.filter(row => !inheritedRows.has(row))].map((row, ordinal) => immutable({ ...row, ordinal }))
    const pages: SelectedResultPageV1[] = []
    for (const row of rows) {
      let page = pages.at(-1)
      if (!page || canonicalJsonData(page.extent) !== canonicalJsonData(row.extent) || page.rows.length >= SELECTED_RESULT_METADATA_LIMITS.pageRows
        || pageBytes({ ...page, rows: [...page.rows, row] }) > SELECTED_RESULT_METADATA_LIMITS.pageBytes) {
        page = { version: 1, ordinal: pages.length, firstRow: row.ordinal, extent: row.extent, rows: [] }; pages.push(page)
      }
      page.rows = [...page.rows, row]
      if (pageBytes(page) > SELECTED_RESULT_METADATA_LIMITS.pageBytes) return { kind: 'refused', reason: 'metadata-limit' }
    }
    immutable(pages)
    let previous = seedHash('ih.selected-results.start.v1', { version: 1, rows: rows.length, pages: pages.length })
    for (const page of pages) previous = seedHash('ih.selected-results.page.v1', { previous, page })
    const summary = immutable({ version: 1 as const, rows: rows.length, pages: pages.length,
      digest: seedHash('ih.selected-results.end.v1', { previous, rows: rows.length, pages: pages.length }) })
    const stream = <T>(values: readonly T[]): AsyncIterable<T> => ({
      [Symbol.asyncIterator]() {
        let index = 0
        return {
          async next(): Promise<IteratorResult<T>> {
            assertCurrent(); await Promise.resolve(); assertCurrent()
            return index < values.length ? { value: values[index++]!, done: false } : { value: undefined, done: true }
          },
          async return(): Promise<IteratorResult<T>> {
            assertCurrent(); await Promise.resolve(); assertCurrent(); index = values.length
            return { value: undefined, done: true }
          },
          async throw(cause: unknown): Promise<IteratorResult<T>> {
            assertCurrent(); await Promise.resolve(); assertCurrent(); throw cause
          },
        }
      },
    })
    assertCurrent()
    return { kind: 'selected', results: Object.freeze({ summary, assertCurrent, pages: () => stream(pages), classifications: () => stream(classifications) }) }
  } catch (cause) {
    return { kind: 'refused', reason: changed ? 'source-changed' : cause instanceof TypeError && cause.message === 'ambiguous' ? 'ambiguous' : 'unsupported-history' }
  }
}
