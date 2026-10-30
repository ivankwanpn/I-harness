import type { SessionView } from '../managed/types.ts'
import { captureSelectedData } from '../serialization/bounded-json.ts'
import type { HistoryItem } from './history/types.ts'
import type { SeedArtifact, SeedItem, SeedOriginAddress, SeedOmission, SeedResult } from './seed-types.ts'
import { canonicalJsonData } from '../serialization/json-data.ts'
import { seedHash } from './seed-digest.ts'
import { seedInvalid } from './seed-codec.ts'
import { renderConversationItems } from './render-items.ts'
import { eventArchive } from './archive.ts'
import { copyConversationData } from './render.ts'
import type { selectSeedHistory } from './seed-selection.ts'
import { createSeedOriginNormalizer, consumeSelectedOriginPlan, type SeedOriginNormalizer } from './seed-origins.ts'
import type { CompletedPassiveContext } from './passive-seed-context.ts'
import type { HeldSelectedResults } from './selected-results-types.ts'

/** One selected payload capture. Origin and dependency normalization subsequently
 * traverses these captured data only, never the source archive bodies again. */
export function captureSeedSelection(view: SessionView, selected: Extract<ReturnType<typeof selectSeedHistory>, { kind: 'selected' }>) {
  return captureSelection(view, selected)
}
export function captureSeedSelectionForResults(context: CompletedPassiveContext, results: HeldSelectedResults) {
  const plan = consumeSelectedOriginPlan(context, results)
  results.assertCurrent()
  const captured = captureSelection(context.source.view, context.selected, plan)
  results.assertCurrent()
  return captured
}
function captureSelection(view: SessionView, selected: Extract<ReturnType<typeof selectSeedHistory>, { kind: 'selected' }>, fixed?: SeedOriginNormalizer) {
  const descriptors = selected.groups.flatMap(group => group.items)
  const projection = renderConversationItems(eventArchive(view.events), { items: descriptors, diagnostics: selected.diagnostics }, { header: view.header, capturePayload: captureSelectedData })
  const artifacts: SeedArtifact[] = [], omissions: SeedOmission[] = []
  const normalizer = fixed ?? createSeedOriginNormalizer(), origin = normalizer.origin
  const artifactSlots = new Map<string, number>()
  const addArtifact = (ref: SeedArtifact['ref'], origins: SeedArtifact['origins'], use: SeedArtifact['uses'][number]) => {
    const identity = `${ref.id}:${ref.revision}`
    let index = artifactSlots.get(identity)
    if (index === undefined) { index = artifacts.length; artifacts.push({ ref: copyConversationData(ref), origins: [], uses: [] }); artifactSlots.set(identity, index) }
    const artifact = artifacts[index]!
    if (canonicalJsonData(artifact.ref) !== canonicalJsonData(ref)) seedInvalid()
    artifacts[index] = { ...artifact, origins: [...new Map([...artifact.origins, ...origins].map(address => [canonicalJsonData(address), address])).values()],
      uses: artifact.uses.some(prior => canonicalJsonData(prior) === canonicalJsonData(use)) ? artifact.uses : [...artifact.uses, use] }
    return index
  }
  const localAddress = (ref: { seq?: number; part: string; addressable: boolean }): SeedOriginAddress => {
    if (!ref.addressable || ref.seq === undefined) seedInvalid()
    return { origin: 0, seq: ref.seq, part: ref.part }
  }
  const localRefs = (item: HistoryItem) => [...new Map([...item.sources, ...item.provenance.evidence].map(ref => [ref.id, ref])).values()].map(localAddress)
  const images = (messages: SeedItem['messages']) => messages.flatMap((message, index) => Array.isArray(message.content) ? message.content.flatMap((part, partIndex) => part.type === 'image' ? [{ message: index, part: partIndex }] : []) : [])
  const inheritedOmissions = new Map<number, number>()
  const manifest = view.events.find(event => event.type === 'conversation/seed-manifest')
  for (const { ordinal, omission } of selected.inheritedOmissions) {
    if (manifest?.type !== 'conversation/seed-manifest') seedInvalid()
    inheritedOmissions.set(ordinal, omissions.length)
    omissions.push({ ...copyConversationData(omission), source: omission.source.map(address => ({ ...address, origin: origin(manifest, address.origin) })) })
  }
  const inputOmissions = new Map<HistoryItem, number>(), localOmissionStart = omissions.length
  omissions.push(...selected.omissions.map(omission => copyConversationData(omission)))
  for (const [item, old] of selected.omittedInputs) {
    if (!descriptors.includes(item)) continue
    inputOmissions.set(item, localOmissionStart + old)
  }
  let position = 0
  const groups = selected.groups.map(group => ({ extent: selected.rebase(group.extent), items: group.items.map((descriptor): SeedItem => {
    const rendered = projection.items[position++]!, recipe = descriptor.recipes.find(recipe => recipe.kind === 'seed-item')
    const record = view.events[descriptor.establishmentIndex]
    if (record?.type === 'conversation/seed-group' && recipe) {
      const manifest = view.events.find(event => event.type === 'conversation/seed-manifest')
      if (manifest?.type !== 'conversation/seed-manifest') seedInvalid()
      const { messages: _messages, ...metadata } = record.group.items[recipe.item!]!
      const item = { ...copyConversationData(metadata), messages: rendered.messages } as SeedItem
      const rebaseAddress = (address: SeedOriginAddress) => ({ ...address, origin: origin(manifest, address.origin) })
      const rebaseRefs = (refs: readonly SeedOriginAddress[]) => refs.map(rebaseAddress)
      const importedArtifact = (old: number, use: SeedArtifact['uses'][number]) => {
        const artifact = manifest.artifacts[old]; if (!artifact) seedInvalid()
        return addArtifact(artifact.ref, rebaseRefs(artifact.origins), use)
      }
      const base = { ...item, extent: selected.rebase(item.extent), messages: rendered.messages, origins: rebaseRefs(item.origins),
        sourceProvenance: item.sourceProvenance.map(provenance => ({ ...provenance, origin: origin(manifest, provenance.origin) })) }
      if (item.kind === 'input') {
        let omittedWork: number | undefined
        if (item.input.omittedWork !== undefined) {
          omittedWork = inheritedOmissions.get(item.input.omittedWork)
          if (omittedWork === undefined) seedInvalid()
        }
        return { ...base, kind: 'input', input: { ...item.input, raw: rebaseRefs(item.input.raw), derivedContext: rebaseRefs(item.input.derivedContext), ...(omittedWork === undefined ? {} : { omittedWork }) } }
      }
      if (item.kind === 'summary') return { ...base, kind: 'summary' }
      return { ...base, kind: 'exchange', calls: item.calls.map(call => ({ ...call, source: rebaseRefs(call.source) })), sourceAcceptance: item.sourceAcceptance,
        results: item.results.map((result): SeedResult => result.kind === 'legacy' ? { ...result, source: rebaseRefs(result.source) } : { ...result, source: rebaseRefs(result.source),
          sourceRetention: result.sourceRetention.kind === 'artifact' ? { kind: 'artifact', artifact: importedArtifact(result.sourceRetention.artifact, { kind: 'result' }) } : result.sourceRetention,
          ...(result.dependencies?.kind === 'catalog' ? { dependencies: { ...result.dependencies, artifact: importedArtifact(result.dependencies.artifact, { kind: 'dependency-catalog', count: result.dependencies.count }) } } : {}) }) }
    }
    const provenance = rendered.provenance
    const base = { extent: selected.rebase(descriptor.extent ?? { kind: 'unframed' }), scope: provenance.scope,
      ...(provenance.producer === undefined ? {} : { producer: provenance.producer }), origins: localRefs(descriptor),
      sourceProvenance: [{ origin: 0, kind: provenance.kind, authority: provenance.authority, scope: provenance.scope, ...(provenance.producer === undefined ? {} : { producer: provenance.producer }) }], messages: rendered.messages }
    if (descriptor.kind === 'summary') return { ...base, kind: 'summary' }
    if (descriptor.kind === 'input') {
      const omittedWork = inputOmissions.get(descriptor)
      return { ...base, kind: 'input', input: { raw: base.origins.filter(ref => ['message', 'admission', 'image'].includes(ref.part)),
        derivedContext: descriptor.recipes.some(recipe => view.events[recipe.index!]?.type === 'user/message' && ('seedInputContext' in view.events[recipe.index!]! || 'inputPreparation' in view.events[recipe.index!]!)) ? base.origins : [],
        media: images(base.messages), ...(omittedWork === undefined ? {} : { omittedWork }) } }
    }
    const results: SeedResult[] = [], resultById = new Map<string, number>()
    for (const [messageIndex, message] of base.messages.entries()) if (message.role === 'tool') {
      const ref = descriptor.calls.find(call => call.callId === message.toolCallId)?.result
      const event = ref && view.events[ref.eventIndex]
      if (event?.type !== 'tool/result') seedInvalid()
      const source = [localAddress(ref!)]
      const media = images(base.messages).filter(image => descriptor.recipes[image.message]?.index === ref!.eventIndex)
      const envelope = event.envelope
      resultById.set(message.toolCallId, results.length)
      if (!envelope) { results.push({ kind: 'legacy', message: messageIndex, source, media, ...(message.isError ? { isError: true } : {}) }); continue }
      const retention = envelope.retention
      results.push({ kind: 'envelope', message: messageIndex, source, media, execution: { ...envelope.execution },
        sourceRetention: retention.kind === 'inline' ? { kind: 'inline-observation', encodedBytes: retention.encodedBytes } : retention.kind === 'artifact'
          ? { kind: 'artifact', artifact: addArtifact(retention.ref, source, { kind: 'result' }) } : { ...retention },
        ...(envelope.dependencies ? { dependencies: envelope.dependencies.kind === 'artifact-set'
          ? { kind: 'catalog', count: envelope.dependencies.count, artifact: addArtifact(envelope.dependencies.ref, source, { kind: 'dependency-catalog', count: envelope.dependencies.count }) }
          : { ...envelope.dependencies } } : {}) })
    }
    const calls = base.messages.flatMap((message, assistantMessage) => message.role !== 'assistant' ? [] : (message.toolCalls ?? []).map((call, callIndex) => {
      const metadata = descriptor.calls.find(candidate => candidate.callId === call.id), result = resultById.get(call.id)
      if (!metadata || result === undefined || !['success', 'error', 'not-dispatched'].includes(metadata.outcome)) seedInvalid()
      return { id: call.id, name: call.name, assistantMessage, call: callIndex, result, outcome: metadata.outcome as 'success' | 'error' | 'not-dispatched', source: [metadata.call, metadata.dispatch].flatMap(ref => ref ? [localAddress(ref)] : []) }
    }))
    return { ...base, kind: 'exchange', calls, results, sourceAcceptance: rendered.exchange?.acceptance ?? 'legacy-inferred' }
  }) }))
  // Normalize every index in the captured DTO, including the old slot zero.
  const inheritedOrigins = fixed ? normalizer.inheritedOrigins() : normalizer.finalize()
  const rebased = new WeakSet<object>()
  const rebase = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (rebased.has(value)) return
    rebased.add(value)
    if (Object.hasOwn(value, 'origin') && !fixed) { const address = value as { origin: number }; address.origin = normalizer.remap(address.origin) }
    for (const child of Object.values(value)) rebase(child)
  }
  // Rendered messages are immutable; only provenance descriptors have origins.
  for (const group of groups) for (const item of group.items) { rebase(item.origins); rebase(item.sourceProvenance); if (item.kind === 'input') { rebase(item.input.raw); rebase(item.input.derivedContext) } if (item.kind === 'exchange') { for (const call of item.calls) rebase(call.source); for (const result of item.results) rebase(result.source) } }
  rebase(artifacts); rebase(omissions)
  const related = omissions.map(() => [] as number[])
  let inputOrdinal = 0
  for (const group of groups) for (const item of group.items) if (item.kind === 'input') {
    if (item.input.omittedWork !== undefined) related[item.input.omittedWork]!.push(inputOrdinal)
    inputOrdinal++
  }
  const normalizedOmissions = omissions.map((omission, index) => {
    const { digest: _, ...metadata } = omission, preimage = { ...metadata, relatedInputs: related[index]! }
    return { ...preimage, digest: seedHash('ih.semantic-seed.omission.v1', preimage) }
  })
  return { inheritedOrigins, groups, artifacts, omissions: normalizedOmissions }
}
