import { estimateContent, projectionFingerprint } from '@i-harness/token-meter'
import { copyConversationData, type ConversationSourceRef, type ConversationCoverage } from '@i-harness/core-session'
import type { ContextSnapshot } from '../contracts/snapshot.ts'
import type { ReductionGroup, ReductionPolicy, ReductionRun } from './contracts.ts'

const refs = (item: ContextSnapshot['conversation']['items'][number]) => [...item.sources, ...item.provenance.evidence,
  ...(item.unit ? [item.unit.source] : []), ...(item.exchange?.calls ?? []).flatMap(call => [call.call, call.result, call.dispatch].filter((ref): ref is ConversationSourceRef => !!ref))]
const safe = (ref: ConversationSourceRef) => ref.addressable && Number.isSafeInteger(ref.seq) && ref.seq! >= 0 && ref.part.length > 0
function coverage(item: ContextSnapshot['conversation']['items'][number]): ConversationCoverage {
  if (!item.ref) throw new Error('Unsafe reduction item')
  const sources = [...new Map([...item.sources, ...item.provenance.evidence].map(ref => [JSON.stringify([ref.seq, ref.part]), { seq: ref.seq!, part: ref.part }])).values()]
    .sort((a, b) => a.seq - b.seq || Buffer.compare(Buffer.from(a.part), Buffer.from(b.part)))
  return { item: item.ref, sources }
}
/** Physical/evidence sharing closes an interval: no interleaved member may be cut. */
export function reductionGroups(snapshot: ContextSnapshot, protectedSeqs: readonly number[] = []): readonly ReductionGroup[] {
  const items = snapshot.conversation.items, parent = items.map((_, i) => i), sourceOwner = new Map<string, number>()
  const root = (i: number): number => parent[i] === i ? i : parent[i] = root(parent[i]!)
  for (const [i, item] of items.entries()) for (const ref of refs(item)) {
    const key = ref.id, prior = sourceOwner.get(key)
    if (prior !== undefined) parent[root(i)] = root(prior)
    sourceOwner.set(key, i)
  }
  const end = new Map<number, number>()
  for (let i = 0; i < items.length; i++) end.set(root(i), i)
  const protectedItems = new Set(snapshot.protection.itemIds), protectedSources = new Set(snapshot.protection.sourceIds), seqs = new Set(protectedSeqs)
  const groups: ReductionGroup[] = []
  for (let i = 0; i < items.length;) {
    let last = end.get(root(i))!
    for (let j = i; j <= last; j++) last = Math.max(last, end.get(root(j))!)
    const members = items.slice(i, last + 1)
    const complete = members.every(item => item.kind !== 'legacy-fragment' && !!item.ref && refs(item).every(safe)
      && (!item.unit || item.unit.state === 'closed') && (!item.exchange || item.exchange.state === 'closed')
      && (item.exchange?.calls ?? []).every(call => call.outcome !== 'pending' && call.outcome !== 'unknown'))
    const protectedGroup = !complete || members.some(item => protectedItems.has(item.id) || item.provenance.scope === 'session'
      || refs(item).some(ref => protectedSources.has(ref.id) || ref.seq !== undefined && seqs.has(ref.seq)))
    const covered = complete ? members.map(coverage) : []
    groups.push(Object.freeze({ id: projectionFingerprint(members), items: Object.freeze(members), coverage: Object.freeze(covered),
      protected: protectedGroup, complete, tokens: estimateContent(copyConversationData(members.flatMap(item => item.messages))) }))
    i = last + 1
  }
  return Object.freeze(groups)
}
/** Open/protected inputs never pay the complete exchange tail budget. */
export function selectReductionRuns(snapshot: ContextSnapshot, policy: ReductionPolicy, protectedSeqs?: readonly number[]): readonly ReductionRun[] {
  const groups = reductionGroups(snapshot, protectedSeqs), tail = new Set<string>()
  let retained = 0, exchanges = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!
    if (!group.complete || group.protected || !group.items.some(item => item.kind === 'exchange')) continue
    if (exchanges && retained >= (policy.retainTokens ?? 0)) break
    tail.add(group.id); retained += group.tokens; exchanges++
  }
  const runs: ReductionRun[] = [], pending: ReductionGroup[] = []
  const close = () => { if (pending.some(group => group.items.some(item => item.kind !== 'summary'))) {
    const selected = Object.freeze(pending.slice()); runs.push(Object.freeze({ id: projectionFingerprint(selected.map(group => group.id)), groups: selected }))
  }; pending.length = 0 }
  for (const group of groups) { if (group.protected || tail.has(group.id)) close(); else pending.push(group) }
  close()
  return Object.freeze(runs)
}
