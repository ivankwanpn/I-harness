import type { SessionEventView } from '../../managed/types.ts'
import { conversationSeq, validateConversationEventShape } from '../../events/conversation.ts'
import { addressKey, replacementFormatError } from '../../events/replacement.ts'
import { historyFact, type HistoryArchive, type HistoryFact } from './facts.ts'
import { projectHistory, validateHistoricalReplacement } from './replacements.ts'

/** The existing validation owner's staged logical metadata. This registry is
 * structural only; it neither retains an event array nor renders payloads. */
export function createHistoryIndex(formatVersion: number) {
  const facts = new Map<number, HistoryFact>()
  const counts = new Map<number, number>()
  const dependencies = new Map<number, ReadonlySet<number>>()
  const replacementAddresses = new Set<number>()
  const consumedSources = new Set<string>()
  const admissions = new Map<string, number | undefined>()
  let count = 0
  return {
    history: (throughSeq?: number) => projectHistory({ length: count, get: position => facts.get(position)! }, throughSeq),
    dependencies: () => new Map([...dependencies].map(([seq, required]) => [seq, new Set(required)])),
    stage(read?: (index: number) => SessionEventView | undefined) {
      const nextFacts = new Map<number, HistoryFact>(), nextCounts = new Map<number, number>()
      const nextDependencies = new Map<number, ReadonlySet<number>>(), nextAddresses = new Set<number>()
      const nextConsumed = new Set<string>(), nextAdmissions = new Map<string, number | undefined>()
      let stagedLength = 0
      return { advance(event: SessionEventView) {
        validateConversationEventShape(event, formatVersion)
        const position = count + stagedLength++, fact = historyFact(event, position)
        if (event.type === 'agent/input/admitted') nextAdmissions.set(event.inputId, event.seq)
        if (event.type === 'user/message') for (const id of [event.input?.inputId, event.imageInputId]) {
          if (id === undefined) continue
          const admission = nextAdmissions.has(id) ? nextAdmissions.get(id) : admissions.get(id)
          if (admission !== undefined) {
            const source = addressKey({ seq: admission, part: 'admission' })
            if (consumedSources.has(source) || nextConsumed.has(source)) replacementFormatError('missing-source', event.seq)
          }
        }
        if (event.type === 'compaction/replacement') {
          const archive: HistoryArchive = { length: position, get: index => nextFacts.get(index) ?? facts.get(index)! }
          const required = validateHistoricalReplacement(archive, fact)
          if (read) for (const prior of facts.values()) if (prior.seq !== undefined && required.has(prior.seq)) {
            const actual = read(prior.index)
            if (!actual || JSON.stringify(historyFact(actual, prior.index)) !== JSON.stringify(prior)) replacementFormatError('unsafe-address', event.seq)
          }
          nextDependencies.set(event.seq!, required)
          nextAddresses.add(event.seq!)
          for (const seq of required) nextAddresses.add(seq)
          for (const entry of event.coverage) for (const source of entry.sources) nextConsumed.add(addressKey(source))
        }
        if (conversationSeq(event.seq)) {
          const existing = nextCounts.get(event.seq) ?? counts.get(event.seq) ?? 0
          if (existing && (replacementAddresses.has(event.seq) || nextAddresses.has(event.seq))) replacementFormatError('unsafe-address', event.seq)
          nextCounts.set(event.seq, existing + 1)
        }
        nextFacts.set(position, fact)
      }, commit() {
        for (const [key, value] of nextFacts) facts.set(key, value)
        for (const [key, value] of nextCounts) counts.set(key, value)
        for (const [key, value] of nextDependencies) dependencies.set(key, value)
        for (const seq of nextAddresses) replacementAddresses.add(seq)
        for (const source of nextConsumed) consumedSources.add(source)
        for (const [id, seq] of nextAdmissions) admissions.set(id, seq)
        count += stagedLength
      } }
    },
  }
}
