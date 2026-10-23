import type { InstructionApplicableDependencies, InstructionCandidateDependency, InstructionSnapshot, InstructionSourceStatus, SourceReliability } from './contracts.ts'
import { digest, frozen, type Discovery, type Slot } from './discovery.ts'
import { readSource, utf8Prefix, type ReadResult } from './reader.ts'

export const reliability = (values: readonly SourceReliability[]): SourceReliability => values.includes('unavailable') ? 'unavailable' : values.includes('pending') ? 'pending' : 'ready'
export function candidateFingerprint(c: Omit<InstructionCandidateDependency, 'fingerprint'>): string { return digest(['instruction-dependency-v1', c]) }
export function applicableFingerprint(scopeKey: string, candidates: readonly InstructionCandidateDependency[]): string { return digest(['instruction-applicable-v1', scopeKey, candidates.map(c => c.fingerprint)]) }
export function emptySnapshot(ready: boolean): InstructionSnapshot { return frozen({ revision: 0, fingerprint: digest(['instruction-text-v1', '', []]), text: '', bytes: 0, sources: [], candidates: [], applicable: [], reliability: ready ? 'ready' : 'unavailable', complete: ready }) }
export interface CachedRead { allowance: number; value: ReadResult; canonicalPath?: string }
export async function buildSnapshot(discovery: Discovery, maxBytes: number, cache: Map<string, CachedRead>, dirty: ReadonlySet<string>, state: (slot: Slot) => { reliability: SourceReliability; pendingIds: string[] }, valid: () => boolean): Promise<{ snapshot: InstructionSnapshot; changed: boolean }> {
  let text = '', changed = false
  const sources: InstructionSourceStatus[] = [], candidates: InstructionCandidateDependency[] = [], incomplete = new Set<string>(), labels: string[] = []
  for (const slot of discovery.slots) {
    const status = state(slot)
    let result: ReadResult | undefined
    let rendered = '', sourceState: InstructionSourceStatus['state'] = slot.selected ? 'loaded' : 'shadowed'
    if (slot.selected) {
      if (slot.outside) { sourceState = 'outside-scope'; incomplete.add(slot.slotId); cache.delete(slot.slotId); status.reliability = 'unavailable' }
      else if (slot.presence !== 'regular') { sourceState = 'unreadable'; incomplete.add(slot.slotId); status.reliability = 'unavailable' }
      else {
        const remaining = maxBytes - Buffer.byteLength(text), header = `${text ? '\n\n' : ''}### ${slot.path} [${slot.global ? 'global ' : ''}scope: ${slot.scopeRoot}]\n\n`
        const headerBytes = Buffer.byteLength(header), contentSpace = Math.max(0, remaining - headerBytes)
        const marker = '\n(truncated)', expectedTruncation = (slot.observedSize ?? 0) > contentSpace
        const allowance = Math.max(0, contentSpace - (expectedTruncation ? Buffer.byteLength(marker) : 0))
        const prior = cache.get(slot.slotId)
        if (prior && !dirty.has(slot.slotId) && prior.allowance === allowance && prior.canonicalPath === slot.canonicalPath) result = prior.value
        else {
          result = await readSource(slot, allowance)
          if (!valid() || result.changed) { changed = true; break }
          if (result.failure === 'unreadable' && prior) result = { ...prior.value, failure: 'unreadable' }
          else if (result.failure) cache.delete(slot.slotId)
          else cache.set(slot.slotId, { allowance, value: result, canonicalPath: slot.canonicalPath })
        }
        if (result.failure) { sourceState = result.failure === 'outside-scope' ? 'outside-scope' : 'unreadable'; status.reliability = 'unavailable'; incomplete.add(slot.slotId) }
        if (!result.failure || result.failure === 'unreadable' && result.body) {
          const truncated = result.truncated || expectedTruncation || headerBytes > remaining
          if (truncated) { incomplete.add(slot.slotId); if (!result.failure) sourceState = 'truncated' }
          // Reserve the marker before reading; a tiny budget can contain only a header prefix.
          rendered = utf8Prefix(header + result.body + (truncated ? marker : ''), remaining)
        }
      }
    }
    if (slot.presence !== 'absent') sources.push({ path: slot.path, scopeRoot: slot.scopeRoot, scopeDirectory: slot.scopeDirectory, kind: slot.kind, state: sourceState, bytes: Buffer.byteLength(rendered), ...(result?.contentHash ? { contentHash: result.contentHash, hashScope: result.hashScope } : {}) })
    if (rendered) { text += rendered; labels.push(slot.slotId) }
    const c = { slotId: slot.slotId, path: slot.path, scopeRoot: slot.scopeRoot, scopeDirectory: slot.scopeDirectory, kind: slot.kind, presence: slot.presence, selected: slot.selected, ...(slot.canonicalPath ? { canonicalPath: slot.canonicalPath } : {}), ...(result?.contentHash ? { contentHash: result.contentHash, hashScope: result.hashScope } : {}), ...(slot.observedSize === undefined ? {} : { observedSize: result?.observedSize ?? slot.observedSize }), ...status }
    candidates.push({ ...c, fingerprint: candidateFingerprint(c) })
  }
  const byId = new Map(candidates.map(c => [c.slotId, c]))
  const applicable: InstructionApplicableDependencies[] = discovery.targets.map(t => {
    const cs = t.slotIds.flatMap(id => byId.get(id) ?? [])
    if (t.message && sources.length < 256) sources.push({ path: t.target.path, scopeRoot: '', scopeDirectory: t.target.path, kind: 'AGENTS.md', state: t.message.includes('outside') ? 'outside-scope' : 'unreadable', bytes: 0, message: t.message })
    return { target: t.target, scopeKey: t.scopeKey, candidateSlotIds: t.slotIds, fingerprint: applicableFingerprint(t.scopeKey, cs), reliability: t.complete ? reliability(cs.map(c => c.reliability)) : 'unavailable', complete: t.complete && cs.every(c => c.reliability === 'ready' && !incomplete.has(c.slotId)) }
  })
  return { changed, snapshot: frozen({ revision: 0, fingerprint: digest(['instruction-text-v1', text, labels]), text, bytes: Buffer.byteLength(text), sources, candidates, applicable, reliability: reliability(applicable.map(a => a.reliability)), complete: applicable.every(a => a.complete) }) }
}
