import type { HistoryFact } from './facts.ts'
import type { ResultUnit } from './result-units.ts'
import { resultAt } from './result-units.ts'
import type { ResultBasis, ResultClassification } from '../selected-results-types.ts'
import type { SeedOriginAddress } from '../seed-types.ts'

type Denied = Exclude<ResultClassification, { kind: 'included' }>
type NativeProof = { kind: 'proof'; basis: ResultBasis; evidence: readonly SeedOriginAddress[]; indices: readonly number[]; parent: ResultUnit }
const refused = (reason: 'ambiguous' | 'unsupported-history'): Denied => ({ kind: 'refused', reason })
/** Exact recorded identity joins only; no text, argument or call-prefix recipe. */
export function createNativeResultIndex(facts: readonly HistoryFact[], units: readonly ResultUnit[], sourceSessionId: string, upper: number, branch: (fact: HistoryFact) => boolean) {
  const byIdentity = new Map<string, HistoryFact[]>(), cells = new Map<string, HistoryFact[]>(), cellCalls = new Map<string, HistoryFact[]>(), parents = new Map<string, ResultUnit[]>()
  const add = <T>(map: Map<string, T[]>, key: string, value: T) => { const entries = map.get(key) ?? []; entries.push(value); map.set(key, entries) }
  for (const value of facts) if (value.index < upper) {
    const id = value.type === 'tool/call' ? value.callId : value.nativeCallId
    if (id !== undefined) add(byIdentity, `${value.type}:${id}`, value)
    if (value.cellId && value.type === 'code/cell') add(cells, value.cellId, value)
    if (value.cellId && value.type === 'code/call') add(cellCalls, value.cellId, value)
  }
  for (const unit of units) for (const call of unit.item.calls) add(parents, call.callId, unit)
  const get = (type: string, id: string | undefined) => id === undefined ? [] : byIdentity.get(`${type}:${id}`) ?? []
  const scoped = (type: string, id: string | undefined) => { const all = get(type, id), current = all.filter(branch); return current.length ? current : all }
  function prove(fact: HistoryFact): NativeProof | Denied {
    const callId = fact.legacyResult?.callId ?? fact.nativeCallId
    const calls = scoped('code/call', callId)
    if (calls.length > 1 || get('tool/call', callId).some(branch)) return refused('ambiguous')
    if (callId !== undefined && calls.length !== 1) return refused('unsupported-history')
    const call = calls[0], cellId = fact.cellId ?? call?.cellId
    if (!cellId || call && fact.cellId !== undefined && call.cellId !== fact.cellId) return refused('ambiguous')
    const cellFacts = cells.get(cellId) ?? []
    if (cellFacts.some(cell => cell.cellSessionId !== undefined && cell.cellSessionId !== sourceSessionId)) return refused('ambiguous')
    const started = cellFacts.filter(cell => cell.cellState === 'started'), completed = cellFacts.at(-1)
    if (started.length > 1) return refused('ambiguous')
    if (!started.length || !completed) return refused('unsupported-history')
    const links = new Set([...cellFacts, ...(cellCalls.get(cellId) ?? [])].flatMap(value => value.parentCallId === undefined ? [] : [value.parentCallId]))
    if (links.size > 1) return refused('ambiguous')
    const parentId = [...links][0]
    if (!parentId) return refused('unsupported-history')
    const parentUnits = [...new Set(parents.get(parentId) ?? [])]
    if (parentUnits.length > 1) return refused('ambiguous')
    const parent = parentUnits[0]
    if (!parent || !parent.item.step?.acceptance || parent.state !== 'closed' || parent.partial) return refused('unsupported-history')
    const parentCall = parent.item.calls.find(value => value.callId === parentId)!
    if (!parentCall.dispatch || !parentCall.result || parentCall.outcome === 'unknown' || parentCall.outcome === 'pending') return refused('unsupported-history')
    const proof: HistoryFact[] = [started[0]!, completed]
    if (call) {
    const results = scoped('code/result', callId), dispatches = scoped('code/dispatch', callId)
      if (results.length > 1 || dispatches.length > 1) return refused('ambiguous')
      const result = results[0], dispatch = dispatches[0]
      if (result && (result.nativeName !== call.nativeName || result.cellId !== cellId) || dispatch && (dispatch.cellId !== cellId || dispatch.nativeEventSeq !== undefined && dispatch.nativeEventSeq !== call.seq)) return refused('ambiguous')
      if (completed.cellState !== 'completed') return { kind: 'excluded', reason: 'native-not-completed' }
      if (!result || !dispatch || !result.resultExecution || result.resultExecution.outcome === 'unknown' || result.resultExecution.dispatch !== 'dispatched') return refused('unsupported-history')
      if (call.index <= started[0]!.index || dispatch.index <= call.index || result.index <= dispatch.index || result.index >= completed.index) {
        if (completed.cellState === 'completed') return refused('ambiguous')
      }
      proof.push(call, dispatch, result)
    }
    if (completed.cellState !== 'completed') return { kind: 'excluded', reason: 'native-not-completed' }
    if (fact.index <= started[0]!.index || fact.index >= completed.index && fact.type !== 'context/result-ref' || started[0]!.index >= completed.index) return refused('ambiguous')
    const acceptance = resultAt(parent.item.step.acceptance, 'acceptance')
    const parentProof = [parentCall.call, parentCall.dispatch, parentCall.result].map(at => ({ origin: 0, seq: at!.seq!, part: at!.part }))
    const at = resultAt(started[0]!), closedAt = resultAt(completed)
    return { kind: 'proof', basis: { kind: 'standalone-native', unit: { kind: 'code-cell', at, closedAt }, completedCell: closedAt },
      evidence: [...proof.map(value => resultAt(value)), ...parentProof, acceptance, parent.unit.at, parent.unit.closedAt,
        ...(parent.consumption ? [parent.consumption.first, parent.consumption.latest] : [])],
      indices: [...new Set([...proof.map(value => value.index), ...parent.indices])], parent }
  }
  return { prove, hasCall: (id: string | undefined) => get('code/call', id).length > 0 }
}
