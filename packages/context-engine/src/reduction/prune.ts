import { renderPruneSubstitute, type PruneRecord } from '@i-harness/core-session'
import type { ContextSnapshot } from '../contracts/snapshot.ts'
import type { ReductionPolicy, ReductionRun, ReductionRewrite } from './contracts.ts'

/** Price/render only actual selected visible payload, never a reconstructed Session. */
export function pruneProposal(snapshot: ContextSnapshot, run: ReductionRun, policy: ReductionPolicy): ReductionRewrite[] {
  const config = policy.prune
  if (!config?.enabled) return []
  const counts = new Map<string, number>()
  for (const item of snapshot.conversation.items) for (const call of item.exchange?.calls ?? []) counts.set(call.callId, (counts.get(call.callId) ?? 0) + 1)
  const records: PruneRecord[] = []
  for (const group of run.groups) for (const item of group.items) for (const message of item.messages) {
    if (message.role !== 'tool' || typeof message.content !== 'string' || message.content.length <= config.thresholdChars || counts.get(message.toolCallId) !== 1) continue
    const call = item.exchange?.calls.find(call => call.callId === message.toolCallId)
    if (!call?.result || !call.result.addressable || !item.sources.some(ref => ref.id === call.result!.id)) continue
    const text = message.content, head = text.slice(0, config.headChars), tail = text.slice(-config.tailChars)
    // Repruning a substitute would lie about original removal provenance.
    if (text.includes('…(pruned ')) continue
    const record = { callId: message.toolCallId, head, tail, removedBytes: Buffer.byteLength(text.slice(head.length, text.length - tail.length)) }
    if (renderPruneSubstitute(record).length < text.length) records.push(record)
  }
  return records.length ? [{ type: 'compaction/prune', version: 1, pruned: records }] : []
}
