import { conversationId } from '../../events/conversation.ts'
import type { LegacyStep } from '../legacy.ts'
import type { ConversationSources } from '../sources.ts'
import { historyEntries, type HistoryArchive, type HistoryFact } from './facts.ts'
import type { HistoryVisibility } from './visibility.ts'

/** Source proof only. Failure's inferred legacy end is never an explicit end.
 * Inspect the entire physical interval and all original call references before
 * visibility or audit projection can erase evidence of an effect. */
export function failedAuditEvidence(archive: HistoryArchive, steps: readonly LegacyStep[], visibility: HistoryVisibility, sources: ConversationSources) {
  const evidence = new Map<LegacyStep, { readonly failureIndex: number; readonly endIndex: number }>()
  if (!steps.some(step => step.explicitRegion && step.failed && !step.acceptance)) return evidence
  const intervals = new Map<number, number[]>(), calls = new Map<string, number[]>(), results = new Map<string, number[]>()
  const dispatches = new Set<string>(), acceptances = new Set<number>(), attempts = new Map<string, number>()
  const fences: number[] = []
  const add = (map: Map<string, number[]>, id: string, index: number) => { const values = map.get(id) ?? []; values.push(index); map.set(id, values) }
  let interval: number[] | undefined
  for (const [index, event] of historyEntries(archive)) {
    // Original hidden/rewound/late evidence must not authenticate a new result.
    if (event.type === 'tool/call') add(calls, event.callId!, index)
    else if (event.type === 'tool/result') add(results, event.callId!, index)
    else if (event.type === 'tool/dispatch') dispatches.add(event.callId!)
    else if (event.type === 'model/exchange-accepted') acceptances.add(event.stepStartSeq!)
    else if (event.type === 'conversation/semantics') fences.push(index)
    if (event.type === 'step/start') {
      interval = []; intervals.set(index, interval)
      if (event.attemptId) attempts.set(event.attemptId, (attempts.get(event.attemptId) ?? 0) + 1)
    } else if (event.type === 'turn/start' || event.type === 'turn/end') interval = undefined
    interval?.push(index)
  }
  const visibleSource = (index: number) => visibility.content(archive.get(index)) && sources.ref(index, 'event').addressable
  for (const step of steps) {
    if (!step.explicitRegion || !step.failed || step.acceptance || fences.length !== 1 || fences[0]! >= step.start || !visibleSource(fences[0]!)) continue
    const start = archive.get(step.start), members = intervals.get(step.start)!
    if (!conversationId(start.actionId) || !start.actionId.trim() || !conversationId(start.attemptId) || !start.attemptId.trim()
      || attempts.get(start.attemptId) !== 1 || acceptances.has(start.seq!) || !members?.every(visibleSource)) continue
    if (members.some((index, ordinal) => ordinal > 0 && archive.get(members[ordinal - 1]!).seq! >= archive.get(index).seq!)) continue
    const failures = members.filter(index => archive.get(index).type === 'step/failed'), ends = members.filter(index => archive.get(index).type === 'step/end')
    if (failures.length !== 1 || ends.length !== 1 || failures[0]! >= ends[0]!) continue
    const failureIndex = failures[0]!, endIndex = ends[0]!
    const content = (event: HistoryFact) => ['assistant/message', 'reasoning', 'tool/call', 'tool/result', 'tool/dispatch'].includes(event.type)
    if (members.some(index => index > failureIndex && content(archive.get(index)))) continue
    const memberSet = new Set(members)
    const localCalls = members.filter(index => archive.get(index).type === 'tool/call')
    const localResults = members.filter(index => archive.get(index).type === 'tool/result')
    if (localCalls.length !== localResults.length) continue
    if (!localCalls.every(index => {
      const call = archive.get(index), resultIndices = results.get(call.callId!)
      if (!call.callId || !call.name || calls.get(call.callId)?.length !== 1 || resultIndices?.length !== 1 || dispatches.has(call.callId)) return false
      const resultIndex = resultIndices[0]!, result = archive.get(resultIndex)
      return resultIndex > index && resultIndex < failureIndex && memberSet.has(resultIndex) && result.name === call.name && result.error === true && result.disposition === 'not-dispatched'
    })) continue
    evidence.set(step, Object.freeze({ failureIndex, endIndex }))
  }
  return evidence
}
