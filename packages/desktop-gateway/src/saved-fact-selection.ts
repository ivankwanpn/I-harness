import { canonicalJsonData, type SessionView } from '@i-harness/core-session'
import { effectiveCuts, hidden, type SavedCall } from './saved-process-index.ts'
type Fact = Record<string, any>
export interface SavedFactEvidence { index: number; event: Fact }
const key = (e: Fact) => JSON.stringify([e.type.startsWith('code/') ? 'code' : 'tool', e.cellId ?? null, e.callId])
/** Fixed original source coordinates/content, never a visibility or read grant. */
export function createFixedFactSelection(initial: SessionView, input: readonly SavedFactEvidence[], owner: string, terminalId?: string) {
  const evidence = [...new Map(input.map(item => [item.index, structuredClone(item)])).values()]
  const initialCuts = effectiveCuts(initial.events)
  let cursor = initial.events.length, failed = evidence.some(item => !Number.isSafeInteger(item.index) || item.index < 0 || !initial.events[item.index] || hidden(item.event.seq, initialCuts) || canonicalJsonData(initial.events[item.index]) !== canonicalJsonData(item.event))
  const originalKeys = new Set(evidence.filter(x => /^(tool|code)\/(call|result|dispatch)$/.test(x.event.type)).map(x => key(x.event)))
  const selectedCalls = evidence.filter(x => /^(tool|code)\/call$/.test(x.event.type)).map(x => x.event)
  for (const call of selectedCalls) if (call.type === 'code/call' && evidence.some(item => item.event.type === 'code/cell' && item.event.cellId === call.cellId
    && (item.event.sessionId !== undefined && item.event.sessionId !== owner || (item.event.parentCallId !== undefined || call.parentCallId !== undefined) && item.event.parentCallId !== call.parentCallId))) failed = true
  type Pending = { call: Fact; index: number; dispatch?: SavedFactEvidence; invalid: boolean }
  const pending = new Map<string, Pending>()
  let cuts = initialCuts
  const assert = () => { if (failed) throw new Error('Saved process evidence changed') }
  function consume(raw: unknown, index: number, initialPass: boolean) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const e = raw as Fact
    if (!initialPass && e.type === 'rewind/point' && Number.isSafeInteger(e.seq) && Number.isSafeInteger(e.anchorSeq) && e.anchorSeq < e.seq) {
      const cut = { cutFrom: e.anchorSeq, markerSeq: e.seq }
      if (evidence.some(x => hidden(x.event.seq, [cut]))) failed = true
      for (const [k, slot] of pending) if (hidden(slot.call.seq, [cut]) || slot.dispatch && hidden(slot.dispatch.event.seq, [cut])) pending.delete(k)
      cuts = [...cuts, cut].sort((a, b) => a.cutFrom - b.cutFrom).reduce<typeof cuts>((result, next) => { const last = result.at(-1); if (last && next.cutFrom < last.markerSeq) last.markerSeq = Math.max(last.markerSeq, next.markerSeq); else result.push({ ...next }); return result }, [])
      return
    }
    if (hidden(e.seq, cuts)) return
    if (e.type === 'code/cell') for (const call of selectedCalls) if (call.type === 'code/call' && call.cellId === e.cellId
      && (e.sessionId !== undefined && e.sessionId !== owner || (e.parentCallId !== undefined || call.parentCallId !== undefined) && e.parentCallId !== call.parentCallId)) failed = true
    if (typeof e.type !== 'string' || typeof e.callId !== 'string' || !/^(tool|code)\/(call|dispatch|result)$/.test(e.type)) return
    const k = key(e)
    if (e.type.endsWith('/call')) { pending.set(k, { call: structuredClone(e), index, invalid: pending.has(k) }); return }
    const slot = pending.get(k)
    if (e.type.endsWith('/dispatch')) {
      if (slot) { if (slot.dispatch || e.eventSeq !== undefined && e.eventSeq !== slot.call.seq) slot.invalid = true; slot.dispatch = { index, event: structuredClone(e) } }
      return
    }
    if (!slot) { if (!initialPass && originalKeys.has(k)) failed = true; return }
    if (e.name !== slot.call.name) return
    pending.delete(k)
    if (slot.invalid) { if (!initialPass && originalKeys.has(k)) failed = true; return }
    let value: unknown
    if (Object.hasOwn(e, 'envelope')) {
      const envelope = e.envelope
      if (!Object.hasOwn(e, 'output') && !Object.hasOwn(e, 'isError') && envelope?.execution?.outcome === 'succeeded' && envelope.execution.dispatch === 'dispatched' && envelope.retention?.kind === 'inline') value = envelope.retention.value
    } else if (!e.isError) value = e.output
    if (!initialPass && terminalId && ['terminal_open', 'process_spawn'].includes(slot.call.name) && value && typeof value === 'object' && !Array.isArray(value)) {
      const output = value as Fact
      if (output.id === terminalId && (output.ownerSessionId === undefined || output.ownerSessionId === owner) && !('error' in output)) failed = true
    }
  }
  // One initial pass seeds outstanding invocations with their original positions
  // and dispatches. Later checks consume only newly delivered suffix records.
  for (const [index, event] of initial.events.entries()) consume(event, index, true)
  const proof = {
    append(from: number, events: readonly unknown[]) {
      if (from !== cursor) failed = true
      for (const event of events) consume(event, cursor++, false)
      assert()
    },
    revalidate(fresh: SessionView) {
      const cuts = effectiveCuts(fresh.events)
      for (const item of evidence) if (hidden(item.event.seq, cuts) || !fresh.events[item.index] || canonicalJsonData(fresh.events[item.index]) !== canonicalJsonData(item.event)) failed = true
      if (fresh.events.length < cursor) failed = true
      else if (fresh.events.length > cursor) proof.append(cursor, fresh.events.slice(cursor))
      assert()
    },
    assertCurrent: assert,
  }
  assert(); return proof
}
export function savedCallEvidence(session: SessionView, calls: readonly (SavedCall | undefined)[]): SavedFactEvidence[] {
  const selected = calls.filter((call): call is SavedCall => !!call), indices = new Set<number>(), cuts = effectiveCuts(session.events)
  for (const call of selected) {
    indices.add(call.callIndex); indices.add(call.resultIndex)
    for (let i = call.callIndex + 1; i < call.resultIndex; i++) { const e = session.events[i] as Fact; if (e.type === call.surface + '/dispatch' && e.callId === call.callId && (e.cellId ?? undefined) === call.cellId) indices.add(i) }
  }
  for (const [index, e] of session.events.entries()) if (e.type === 'code/cell' && !hidden(e.seq, cuts) && selected.some(call => call.surface === 'code' && call.cellId === e.cellId)) indices.add(index)
  return [...indices].map(index => ({ index, event: session.events[index] as Fact }))
}
