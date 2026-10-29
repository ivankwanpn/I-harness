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
  const pending = new Map<string, Fact>()
  const assert = () => { if (failed) throw new Error('Saved process evidence changed') }
  const proof = {
    append(from: number, events: readonly unknown[]) {
      if (from !== cursor) failed = true
      for (const raw of events) {
        cursor++
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const e = raw as Fact
        if (e.type === 'rewind/point' && Number.isSafeInteger(e.seq) && Number.isSafeInteger(e.anchorSeq) && e.anchorSeq < e.seq
          && evidence.some(x => hidden(x.event.seq, [{ cutFrom: e.anchorSeq, markerSeq: e.seq }]))) failed = true
        if (e.type === 'code/cell') for (const call of selectedCalls) if (call.type === 'code/call' && call.cellId === e.cellId
          && (e.sessionId !== undefined && e.sessionId !== owner || (e.parentCallId !== undefined || call.parentCallId !== undefined) && e.parentCallId !== call.parentCallId)) failed = true
        if (typeof e.type !== 'string' || typeof e.callId !== 'string' || !/^(tool|code)\/(call|dispatch|result)$/.test(e.type)) continue
        const k = key(e)
        if (e.type.endsWith('/call')) { pending.set(k, e); continue }
        if (e.type.endsWith('/result')) {
          const call = pending.get(k); pending.delete(k)
          if (!call && originalKeys.has(k)) failed = true
          const value = e.output
          if (terminalId && call && ['terminal_open', 'process_spawn'].includes(call.name) && e.name === call.name && value?.id === terminalId && (value.ownerSessionId === undefined || value.ownerSessionId === owner) && !('error' in value)) failed = true
        }
      }
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
