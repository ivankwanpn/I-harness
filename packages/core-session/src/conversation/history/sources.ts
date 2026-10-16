import type { ConversationDiagnostic, ConversationProvenance, ConversationSourceRef } from '../types.ts'
import { historyEntries, type HistoryArchive } from './facts.ts'

/** Structural references share the exact addressing rules with payload sources. */
export function historySources(archive: HistoryArchive, diagnostics: ConversationDiagnostic[]) {
  const counts = new Map<number, number>(), cache = new Map<string, ConversationSourceRef>()
  const valid = (seq: unknown): seq is number => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0
  for (const [, event] of historyEntries(archive)) if (valid(event.seq)) counts.set(event.seq, (counts.get(event.seq) ?? 0) + 1)
  const ref = (eventIndex: number, part: string): ConversationSourceRef => {
    const key = `${eventIndex}:${part}`
    const previous = cache.get(key)
    if (previous) return previous
    const seq = archive.get(eventIndex).seq, addressable = valid(seq) && counts.get(seq) === 1
    const source = Object.freeze({ id: JSON.stringify([null, addressable ? seq : `event:${eventIndex}`, part]), eventIndex, ...(addressable ? { seq } : {}), part, addressable })
    cache.set(key, source)
    return source
  }
  for (const [index, event] of historyEntries(archive)) {
    const code = event.seq === undefined ? 'missing-source-seq' : !valid(event.seq) ? 'invalid-source-seq' : counts.get(event.seq)! > 1 ? 'duplicate-source-seq' : undefined
    if (code) diagnostics.push({ code, sourceIds: [ref(index, 'event').id] })
  }
  const provenance = (index: number, part: string, admissionIndex?: number): ConversationProvenance => ({
    kind: 'unknown', authority: 'unknown', scope: archive.get(index).sessionScope || admissionIndex !== undefined && archive.get(admissionIndex).sessionScope ? 'session' : 'turn',
    evidence: [ref(index, part), ...(admissionIndex === undefined ? [] : [ref(admissionIndex, 'admission')])],
  })
  return { ref, provenance }
}
