import { canonicalJsonData, type SessionView } from '@i-harness/core-session'
import { effectiveCuts, hidden, type SavedCall } from './saved-process-index.ts'
type Fact = Record<string, any>
export interface SavedFactEvidence { index: number; event: Fact }
export interface SavedTerminalSelector { readonly id: string; readonly evidence: readonly SavedFactEvidence[] }
const key = (e: Fact) => JSON.stringify([e.type.startsWith('code/') ? 'code' : 'tool', e.cellId ?? null, e.callId])
/** Fixed original source coordinates/content, never a visibility or read grant. */
export function createFixedFactSelection(initial: SessionView, input: readonly SavedFactEvidence[], owner: string, terminalId?: string) {
  return createFixedFactReplay(initial, [{ id: terminalId, evidence: input }], owner)
}

/** A list holds one original replay. All selected source facts remain fixed. */
export function createFixedTerminalSelections(initial: SessionView, selectors: readonly SavedTerminalSelector[], owner: string) {
  return createFixedFactReplay(initial, selectors, owner)
}

function createFixedFactReplay(initial: SessionView, selections: readonly { id?: string; evidence: readonly SavedFactEvidence[] }[], owner: string) {
  const evidence = new Map<number, { seq: unknown; canonical: string }>()
  const originalKeys = new Set<string>(), terminalIds = new Set<string>()
  const cellParents = new Map<string, { parentCallId: unknown; inconsistent: boolean }>()
  let cuts = effectiveCuts(initial.events)
  let cursor = initial.events.length, failed = false
  const assert = () => { if (failed) throw new Error('Saved process evidence changed') }
  const alternateEvidence = new WeakMap<Fact, string>()
  function encodedCopy(event: Fact): string {
    const cached = alternateEvidence.get(event)
    if (cached !== undefined) return cached
    const encoded = canonicalJsonData(structuredClone(event))
    alternateEvidence.set(event, encoded)
    return encoded
  }
  for (const selection of selections) {
    if (selection.id) terminalIds.add(selection.id)
    // Keep the same last value for a duplicate ordinal within one selection.
    for (const [index, item] of new Map(selection.evidence.map(item => [item.index, item]))) {
      const original = initial.events[index]
      if (!Number.isSafeInteger(index) || index < 0 || !original || hidden(original.seq, cuts)) { failed = true; continue }
      const pinned = evidence.get(index) ?? { seq: original.seq, canonical: canonicalJsonData(original) }
      if (item.event !== original && encodedCopy(item.event) !== pinned.canonical) { failed = true; continue }
      evidence.set(index, pinned)
      if (/^(tool|code)\/(call|result|dispatch)$/.test(original.type)) originalKeys.add(key(original))
      if (original.type === 'code/call') {
        const cell = cellParents.get(original.cellId)
        if (!cell) cellParents.set(original.cellId, { parentCallId: original.parentCallId, inconsistent: false })
        else if (cell.parentCallId !== original.parentCallId) cell.inconsistent = true
      }
    }
  }
  type Pending = { call: Fact; dispatch?: Fact; invalid: boolean }
  const pending = new Map<string, Pending>()
  function consume(raw: unknown, initialPass: boolean) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const e = raw as Fact
    if (!initialPass && e.type === 'rewind/point' && Number.isSafeInteger(e.seq) && Number.isSafeInteger(e.anchorSeq) && e.anchorSeq < e.seq) {
      const cut = { cutFrom: e.anchorSeq, markerSeq: e.seq }
      const range = [cut]
      for (const item of evidence.values()) if (hidden(item.seq, range)) { failed = true; break }
      for (const [k, slot] of pending) if (hidden(slot.call.seq, range) || slot.dispatch && hidden(slot.dispatch.seq, range)) pending.delete(k)
      cuts = [...cuts, cut].sort((a, b) => a.cutFrom - b.cutFrom).reduce<typeof cuts>((result, next) => { const last = result.at(-1); if (last && next.cutFrom < last.markerSeq) last.markerSeq = Math.max(last.markerSeq, next.markerSeq); else result.push({ ...next }); return result }, [])
      return
    }
    if (hidden(e.seq, cuts)) return
    if (e.type === 'code/cell') {
      const cell = cellParents.get(e.cellId)
      if (cell && (cell.inconsistent || e.sessionId !== undefined && e.sessionId !== owner || e.parentCallId !== cell.parentCallId)) failed = true
    }
    if (typeof e.type !== 'string' || typeof e.callId !== 'string' || !/^(tool|code)\/(call|dispatch|result)$/.test(e.type)) return
    const k = key(e)
    if (e.type.endsWith('/call')) { pending.set(k, { call: structuredClone(e), invalid: pending.has(k) }); return }
    const slot = pending.get(k)
    if (e.type.endsWith('/dispatch')) {
      if (slot) { if (slot.dispatch || e.eventSeq !== undefined && e.eventSeq !== slot.call.seq) slot.invalid = true; slot.dispatch = structuredClone(e) }
      return
    }
    if (!slot) { if (!initialPass && originalKeys.has(k)) failed = true; return }
    if (e.name !== slot.call.name) return
    pending.delete(k)
    if (slot.invalid) { if (!initialPass && originalKeys.has(k)) failed = true; return }
    if (initialPass || !terminalIds.size || slot.call.name !== 'terminal_open' && slot.call.name !== 'process_spawn') return
    let value: unknown
    if (Object.hasOwn(e, 'envelope')) {
      const envelope = e.envelope
      if (!Object.hasOwn(e, 'output') && !Object.hasOwn(e, 'isError') && envelope?.execution?.outcome === 'succeeded' && envelope.execution.dispatch === 'dispatched' && envelope.retention?.kind === 'inline') value = envelope.retention.value
    } else if (!e.isError) value = e.output
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const output = value as Fact
      if (terminalIds.has(output.id) && (output.ownerSessionId === undefined || output.ownerSessionId === owner) && !('error' in output)) failed = true
    }
  }
  // One initial pass seeds outstanding invocations with their original positions
  // and dispatches. Later checks consume only newly delivered suffix records.
  for (const event of initial.events) consume(event, true)
  const proof = {
    append(from: number, events: readonly unknown[]) {
      if (from !== cursor) failed = true
      for (const event of events) { consume(event, false); cursor++ }
      assert()
    },
    revalidate(fresh: SessionView) {
      const cuts = effectiveCuts(fresh.events)
      for (const [index, item] of evidence) if (hidden(item.seq, cuts) || !fresh.events[index] || canonicalJsonData(fresh.events[index]) !== item.canonical) failed = true
      if (fresh.events.length < cursor) failed = true
      else if (fresh.events.length > cursor) proof.append(cursor, fresh.events.slice(cursor))
      assert()
    },
    assertCurrent: assert,
  }
  assert(); return proof
}
export function savedCallEvidence(session: SessionView, calls: readonly (SavedCall | undefined)[]): SavedFactEvidence[] {
  const selected = calls.filter((call): call is SavedCall => !!call), indices = new Set<number>()
  const selectedCells = new Set(selected.filter(call => call.surface === 'code').map(call => call.cellId))
  for (const call of selected) {
    indices.add(call.callIndex); indices.add(call.resultIndex)
    for (let i = call.callIndex + 1; i < call.resultIndex; i++) { const e = session.events[i] as Fact; if (e.type === call.surface + '/dispatch' && e.callId === call.callId && (e.cellId ?? undefined) === call.cellId) indices.add(i) }
  }
  if (selectedCells.size) {
    const cuts = effectiveCuts(session.events)
    for (const [index, e] of session.events.entries()) if (e.type === 'code/cell' && selectedCells.has(e.cellId) && !hidden(e.seq, cuts)) indices.add(index)
  }
  return [...indices].map(index => ({ index, event: session.events[index] as Fact }))
}
