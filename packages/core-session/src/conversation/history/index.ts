import type { SessionEventView } from '../../managed/types.ts'
import { conversationSeq, validateConversationEventShape } from '../../events/conversation.ts'
import { addressKey, replacementFormatError } from '../../events/replacement.ts'
import { findCurrentRuntimeContext, historyVisibility } from './visibility.ts'
import { canonicalJsonData } from '../../serialization/json-data.ts'
import { historyFact, type HistoryArchive, type HistoryFact, type HistoryMarkers } from './facts.ts'
import { projectHistory, validateHistoricalReplacement } from './replacements.ts'
import { freezeJsonData } from '../../managed/capture.ts'
import { inheritedResultMembership } from './result-membership.ts'

const freezeMarkers = Object.freeze
const emptyMarkers: HistoryMarkers = freezeMarkers({ firstSemanticsOrdinal: -1, firstReplacementOrdinal: -1 })

/** The existing validation owner's staged logical metadata. This registry is
 * structural only; it neither retains an event array nor renders payloads. */
export function createHistoryIndex(formatVersion: number, validateShape = validateConversationEventShape, inheritedBoundary = 0) {
  const facts = new Map<number, HistoryFact>()
  const counts = new Map<number, number>()
  const dependencies = new Map<number, ReadonlySet<number>>()
  const replacementAddresses = new Set<number>()
  const consumedSources = new Set<string>()
  const admissions = new Map<string, number | undefined>()
  let count = 0, markers = emptyMarkers
  const archive = (): HistoryArchive => ({ length: count, get: position => facts.get(position)! })
  function* iterateSelectedResultRefs() {
    const branch = historyVisibility(facts.values()).branch
    let manifest: HistoryFact | undefined
    for (const fact of facts.values()) if (fact.type === 'conversation/seed-manifest') { manifest = fact; break }
    if (!manifest || !branch(manifest)) return
    const membership = inheritedResultMembership(() => facts.values())
    let selected = membership.next() // validates every current inherited cut before the first yield
    const seen = new Set<string>()
    const unique = (ref: import('../../results/types.ts').ManagedArtifactRef) => { const key = canonicalJsonData(ref); if (seen.has(key)) return false; seen.add(key); return true }
    for (const fact of facts.values()) if (branch(fact)) for (const ordinal of fact.seedArtifactIndices ?? []) {
      const ref = manifest.seedArtifacts![ordinal]!
      if (unique(ref)) yield { ...ref }
    }
    while (!selected.done) {
      const row = selected.value.row
      if (row.protocol === 'managed' && unique(row.ref)) yield { ...row.ref }
      selected = membership.next()
    }
  }
  return {
    resultFacts: (): readonly HistoryFact[] => Object.freeze([...facts.values()]),
    history: (throughSeq?: number) => projectHistory(archive(), throughSeq, markers),
    currentRuntimeContext: () => findCurrentRuntimeContext(archive(), historyVisibility(facts.values()).branch),
    iterateSelectedResultRefs,
    semanticSeedResultRefs: () => [...iterateSelectedResultRefs()],
    dependencies: () => new Map([...dependencies].map(([seq, required]) => [seq, new Set(required)])),
    stage(read?: (index: number) => SessionEventView | undefined, initialShapeValidated = false) {
      const nextFacts = new Map<number, HistoryFact>(), nextCounts = new Map<number, number>()
      const nextDependencies = new Map<number, ReadonlySet<number>>(), nextAddresses = new Set<number>()
      const nextConsumed = new Set<string>(), nextAdmissions = new Map<string, number | undefined>()
      const baseCount = count
      let stagedLength = 0, stagedMarkers = markers
      return { dependencies(event:SessionEventView):readonly number[]{
        if(event.type!=='compaction/replacement')return []
        validateShape(event,formatVersion)
        const position=baseCount+stagedLength,fact=historyFact(event,position,inheritedBoundary)
        const required=validateHistoricalReplacement({length:position,get:index=>nextFacts.get(index)??facts.get(index)!},fact,stagedMarkers)
        return [...facts.values()].filter(prior=>prior.seq!==undefined&&required.has(prior.seq)).map(prior=>prior.index)
      },advance(event: SessionEventView) {
        if (!initialShapeValidated) validateShape(event, formatVersion)
        const position = baseCount + stagedLength++, fact = freezeJsonData(historyFact(event, position, inheritedBoundary)) as HistoryFact
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
          const required = validateHistoricalReplacement(archive, fact, stagedMarkers)
          if (read) for (const prior of facts.values()) if (prior.seq !== undefined && required.has(prior.seq)) {
            const actual = read(prior.index)
            if (!actual || JSON.stringify(historyFact(actual, prior.index, inheritedBoundary)) !== JSON.stringify(prior)) replacementFormatError('unsafe-address', event.seq)
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
        if (fact.type === 'conversation/semantics' && stagedMarkers.firstSemanticsOrdinal === -1) {
          stagedMarkers = freezeMarkers({ ...stagedMarkers, firstSemanticsOrdinal: position })
        } else if (fact.type === 'compaction/replacement' && stagedMarkers.firstReplacementOrdinal === -1) {
          stagedMarkers = freezeMarkers({ ...stagedMarkers, firstReplacementOrdinal: position })
        }
      }, history() {
        return projectHistory({ length: baseCount + stagedLength, get: position => nextFacts.get(position) ?? facts.get(position)! }, undefined, stagedMarkers)
      }, commit() {
        for (const [key, value] of nextFacts) facts.set(key, value)
        for (const [key, value] of nextCounts) counts.set(key, value)
        for (const [key, value] of nextDependencies) dependencies.set(key, value)
        for (const seq of nextAddresses) replacementAddresses.add(seq)
        for (const source of nextConsumed) consumedSources.add(source)
        for (const [id, seq] of nextAdmissions) admissions.set(id, seq)
        count += stagedLength
        markers = stagedMarkers
      } }
    },
  }
}
