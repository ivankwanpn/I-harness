import { isStrictFactData } from '../managed/capture.ts'
import { validManagedArtifactRef } from '../results/validate.ts'
import { validateImages } from '../images.ts'
import { validateNativeWitness } from '../projection/native-witness.ts'
import { canonicalJsonData } from '../serialization/json-data.ts'
import { seedHash, seedPreimage, semanticSourceDomain, semanticSeedDomain, semanticDependencyDigest } from './seed-digest.ts'
import type { SemanticSeed, SemanticSeedV3, SeedItem, SeedOriginAddress, TurnExtent } from './seed-types.ts'
import { seedLayout } from './seed-layout.ts'
import { validateSelectedResultsTable } from './selected-results-codec.ts'
import { validateSeedNative } from './seed-native.ts'
import { validatePassiveCodeStore } from '../projection/passive-code-store/validate.ts'
import { validateSeedHeader, validateSeedSourceEventShape } from './bootstrap-validation.ts'

/** Reconstruct the actual original manifest version once; callers choose full,
 * prefix or structural validation without re-creating a hardcoded V1 body. */
export function semanticSeedFromRecords(header: import('../events/bootstrap.ts').SeedHeader, records: readonly import('../managed/types.ts').SessionEventView[]): SemanticSeed {
  validateSeedHeader(header)
  const manifest = records[0]
  if (!header.seedLength || manifest?.type !== 'conversation/seed-manifest' || manifest.version !== header.version || manifest.codec !== header.codec
    || manifest.digest !== header.seedDigest || manifest.groupCount !== header.groupCount) seedInvalid()
  if (header.version === 3 && (manifest.version !== 3 || header.profile !== manifest.profile || header.resultPageCount !== manifest.resultPageCount || canonicalJsonData(header.results) !== canonicalJsonData(manifest.results))) seedInvalid()
  return semanticSeedBodyFromRecords(records.slice(0, header.seedLength))
}
/** Internal original-capture owner: the birth header does not exist until the
 * request is validated. Reconstruct its actual manifest, never a partial header.
 * This also serves growing prefixes without traversing conversation bodies. */
export function semanticSeedBodyFromRecords(records: readonly import('../managed/types.ts').SessionEventView[]): SemanticSeed {
  return bodyFromRecords(records, false)
}
function bodyFromRecords(records: readonly import('../managed/types.ts').SessionEventView[], partial: boolean): SemanticSeed {
  const manifest = records[0]
  if (manifest?.type !== 'conversation/seed-manifest') seedInvalid()
  validateSeedSourceEventShape(manifest, 13)
  const layout = seedLayout(manifest)
  if (records.length > layout.seedLength || manifest.version === 3 && !partial && records.length !== layout.seedLength) seedInvalid()
  const pages = records.slice(1, 1 + layout.resultPageCount).map((record, ordinal) => {
    validateSeedSourceEventShape(record, 13)
    if (record.type !== 'conversation/seed-results' || record.seq !== 1 + ordinal || record.ordinal !== ordinal || record.manifestSeq !== 0) seedInvalid()
    return record.page
  })
  const groups = records.slice(1 + layout.resultPageCount).map((record, ordinal) => {
    validateSeedSourceEventShape(record, 13)
    if (record.type !== 'conversation/seed-group' || record.seq !== layout.groupSeq(ordinal) || record.ordinal !== ordinal || record.manifestSeq !== 0) seedInvalid()
    return record.group
  })
  const common = { origins: manifest.origins, turns: manifest.turns, omissions: manifest.omissions, artifacts: manifest.artifacts, groups }
  // This wrapper reuses readonly source records; it must not clone discarded
  // conversation bodies merely to reconstruct a validation input.
  if (manifest.version === 3) {
    const seed = { ...common, version: 3, profile: manifest.profile, selection: manifest.selection, results: { summary: manifest.results, pages }, ...(manifest.profile === 'public-completed' ? { passive: manifest.passive } : {}) } as SemanticSeedV3
    if (!partial) validateSemanticSeedStructure(seed)
    return seed
  }
  return (manifest.version === 2 ? { ...common, version: 2, selection: manifest.selection, passive: manifest.passive } : { ...common, version: 1, selection: manifest.selection }) as unknown as SemanticSeed
}

export function validateSelectedResultsRecordPrefix(header: import('../events/bootstrap.ts').SeedHeaderV3, records: readonly import('../managed/types.ts').SessionEventView[]): { kind: 'prefix'; resultPages: number; groups: number } | { kind: 'complete'; seed: SemanticSeedV3 } {
  validateSeedHeader(header)
  if (header.version !== 3 || records.length > header.seedLength) seedInvalid()
  if (!records.length) return { kind: 'prefix', resultPages: 0, groups: 0 }
  const manifest = records[0]
  if (manifest?.type !== 'conversation/seed-manifest' || manifest.version !== 3 || manifest.codec !== header.codec || manifest.digest !== header.seedDigest || manifest.groupCount !== header.groupCount
    || manifest.profile !== header.profile || manifest.resultPageCount !== header.resultPageCount || canonicalJsonData(manifest.results) !== canonicalJsonData(header.results)) seedInvalid()
  const seed = bodyFromRecords(records, true) as SemanticSeedV3
  if (records.length === header.seedLength) {
    validateSemanticSeed(seed)
    if (seedHash(semanticSeedDomain(seed), seed) !== header.seedDigest || semanticDependencyDigest(seed) !== header.dependencyDigest) seedInvalid()
    return { kind: 'complete', seed }
  }
  validateSemanticSeedPrefix(seed)
  return { kind: 'prefix', resultPages: seed.results.pages.length, groups: seed.groups.length }
}

export function seedInvalid(): never { throw new TypeError('Invalid semantic seed') }
export const seedCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const seedDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const seedId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
export function seedFields(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)
      || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
    || required.some(key => !Object.hasOwn(value, key))) seedInvalid()
}
/** A closed tree check precedes all property reads, including discriminants. */
export function seedData(value: unknown): void {
  if (!isStrictFactData(value)) seedInvalid()
  const pending = [value]
  while (pending.length) {
    const current = pending.pop()
    if (current === undefined) seedInvalid()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current) && Reflect.ownKeys(current).length !== current.length + 1) seedInvalid()
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
      if (Array.isArray(current) && key === 'length') continue
      if (!descriptor.enumerable) seedInvalid()
      pending.push(descriptor.value)
    }
  }
}
export function validateTurnExtent(extent: TurnExtent, total: number): void {
  seedFields(extent, ['kind'], extent.kind === 'framed' ? ['first', 'last'] : [])
  if (extent.kind === 'unframed') return
  if (extent.kind !== 'framed' || !seedCount(extent.first) || extent.first < 1 || !seedCount(extent.last) || extent.last < extent.first || extent.last > total) seedInvalid()
}
const reasons = ['quota', 'encoding', 'storage-refused', 'unsupported-owner', 'capture-canceled']
export function validateSemanticSeed<T extends SemanticSeed>(value: T): T
export function validateSemanticSeed(value: unknown): SemanticSeed
export function validateSemanticSeed(value: unknown): SemanticSeed {
  return semanticSeed(value, true)
}
/** Source-only structural profile. It certifies selected export structure,
 * never the integrity of every historical hidden payload. */
export function validateSemanticSeedStructure(value: unknown): SemanticSeed {
  return semanticSeed(value, false)
}
/** Internal growing-prefix validator: every present group is closed, while
 * future table uses/input ordinals and the final digest remain pending. */
export function validateSemanticSeedPrefix(value: unknown): SemanticSeed {
  return semanticSeed(value, true, true)
}
function semanticSeed(value: unknown, payload: boolean, partial = false): SemanticSeed {
  if (payload) seedData(value)
  const version = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'version')?.value : undefined
  const profile = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'profile')?.value : undefined
  seedFields(value, ['version', 'origins', 'selection', 'turns', 'omissions', 'artifacts', 'groups', ...(version === 3 ? ['profile', 'results'] : []), ...(version === 2 || version === 3 && profile === 'public-completed' ? ['passive'] : [])])
  const seed = value as unknown as SemanticSeed
  if (![1, 2, 3].includes(seed.version) || !Array.isArray(seed.origins) || !seed.origins.length) seedInvalid()
  if (seed.version === 3 && (seed.profile !== 'public-completed' && seed.profile !== 'child-history' || seed.profile === 'public-completed' && seed.selection.kind !== 'completed' || seed.profile === 'child-history' && !['all', 'last-turns'].includes(seed.selection.kind))) seedInvalid()
  for (const origin of seed.origins) {
    seedFields(origin, origin.kind === 'session' ? ['kind', 'sessionId', 'revision'] : ['kind', 'contentDigest'])
    if (origin.kind === 'session' ? !seedId(origin.sessionId) || !seedDigest(origin.revision) : origin.kind !== 'anonymous' || !seedDigest(origin.contentDigest)) seedInvalid()
  }
  seedFields(seed.selection, ['kind'], seed.selection.kind === 'last-turns' ? ['count'] : seed.selection.kind === 'completed' ? ['atSeq'] : [])
  if (!['all', 'completed', 'last-turns'].includes(seed.selection.kind)
    || seed.version === 2 && seed.selection.kind !== 'completed'
    || seed.selection.kind === 'last-turns' && (!seedCount(seed.selection.count) || seed.selection.count < 1)
    || seed.selection.kind === 'completed' && seed.selection.atSeq !== undefined && !seedCount(seed.selection.atSeq)) seedInvalid()
  seedFields(seed.turns, ['total', 'completed', 'unframedPrefix'])
  if (!seedCount(seed.turns.total) || typeof seed.turns.unframedPrefix !== 'boolean' || !Array.isArray(seed.turns.completed)) seedInvalid()
  let last = -1
  for (const interval of seed.turns.completed) {
    if (!Array.isArray(interval) || interval.length !== 2 || !seedCount(interval[0]) || interval[0] < 1 || !seedCount(interval[1]) || interval[1] < interval[0] || interval[1] > seed.turns.total || interval[0] <= last + 1) seedInvalid()
    last = interval[1]
  }
  const address = (ref: SeedOriginAddress) => {
    seedFields(ref, ['origin', 'seq', 'part'])
    if (!seedCount(ref.origin) || ref.origin >= seed.origins.length || !seedCount(ref.seq) || typeof ref.part !== 'string' || !ref.part.length || Buffer.byteLength(ref.part) > 64) seedInvalid()
  }
  const addresses = (refs: readonly SeedOriginAddress[]) => { if (!Array.isArray(refs)) seedInvalid(); for (const ref of refs) address(ref) }
  if (![seed.groups, seed.omissions, seed.artifacts].every(Array.isArray)) seedInvalid()
  if (seed.version === 2 || seed.version === 3 && seed.profile === 'public-completed') { seedFields(seed.passive, ['codeStore']); validatePassiveCodeStore(seed.passive.codeStore, seed.turns, seed.groups.length, partial) }
  const used = new Map<number, Set<string>>()
  const artifact = (index: number, use: { kind: 'result' } | { kind: 'dependency-catalog'; count: number }) => {
    if (!seedCount(index) || index >= seed.artifacts.length) seedInvalid()
    if (use.kind === 'dependency-catalog' && (!seedCount(use.count) || !use.count || seed.artifacts[index]!.ref.codec !== 'json-utf8-v1')) seedInvalid()
    const uses = used.get(index) ?? new Set(); uses.add(canonicalJsonData(use)); used.set(index, uses)
  }
  for (const omission of seed.omissions) {
    seedFields(omission, ['extent', 'source', 'digest', 'state', 'calls', 'relatedInputs']); addresses(omission.source); validateTurnExtent(omission.extent, seed.turns.total)
    if (!seedDigest(omission.digest) || !['open', 'unresolved'].includes(omission.state) || !seedCount(omission.calls) || !Array.isArray(omission.relatedInputs) || !omission.relatedInputs.every(seedCount)) seedInvalid()
    if (omission.relatedInputs.some((ordinal, index) => index > 0 && ordinal <= omission.relatedInputs[index - 1]!)) seedInvalid()
    const { digest: _, ...preimage } = omission
    if (omission.digest !== seedHash('ih.semantic-seed.omission.v1', preimage)) seedInvalid()
  }
  for (const group of seed.groups) {
    seedFields(group, ['extent', 'items']); validateTurnExtent(group.extent, seed.turns.total)
    if (!Array.isArray(group.items) || !group.items.length) seedInvalid()
    for (const item of group.items) {
      validateItem(item)
      if (item.extent.kind === 'unframed' ? group.extent.kind !== 'unframed' : group.extent.kind !== 'framed' || item.extent.first < group.extent.first || item.extent.last > group.extent.last) seedInvalid()
    }
  }
  const inputs = seed.groups.flatMap(group => group.items.filter((item): item is Extract<SeedItem, { kind: 'input' }> => item.kind === 'input'))
  for (const [index, omission] of seed.omissions.entries()) {
    const expected = inputs.flatMap((item, ordinal) => item.input.omittedWork === index ? [ordinal] : [])
    if (partial ? expected.some(ordinal => !omission.relatedInputs.includes(ordinal))
      : expected.length !== omission.relatedInputs.length || expected.some((ordinal, position) => omission.relatedInputs[position] !== ordinal)) seedInvalid()
    for (const ordinal of expected) {
      const extent = inputs[ordinal]!.extent
      if (extent.kind === 'unframed' ? omission.extent.kind !== 'unframed' : omission.extent.kind === 'framed' && (extent.first < omission.extent.first || extent.last > omission.extent.last)) seedInvalid()
    }
  }
  function validateItem(item: SeedItem): void {
    seedFields(item, ['kind', 'extent', 'scope', 'origins', 'sourceProvenance', 'messages', ...(item.kind === 'input' ? ['input'] : item.kind === 'exchange' ? ['calls', 'results', 'sourceAcceptance'] : [])], ['producer'])
    if (!['input', 'summary', 'exchange'].includes(item.kind) || !['turn', 'session'].includes(item.scope) || item.producer !== undefined && !seedId(item.producer)) seedInvalid()
    validateTurnExtent(item.extent, seed.turns.total); addresses(item.origins)
    if (!Array.isArray(item.sourceProvenance) || !item.sourceProvenance.length || !Array.isArray(item.messages) || !item.messages.length) seedInvalid()
    for (const provenance of item.sourceProvenance) {
      seedFields(provenance, ['origin', 'kind', 'authority', 'scope'], ['producer'])
      if (!seedCount(provenance.origin) || provenance.origin >= seed.origins.length || !['human', 'plugin', 'tool', 'child-report', 'model', 'summary', 'inherited', 'unknown'].includes(provenance.kind)
        || !['request', 'observation', 'derived', 'unknown'].includes(provenance.authority) || !['turn', 'session'].includes(provenance.scope) || provenance.producer !== undefined && !seedId(provenance.producer)) seedInvalid()
    }
    for (const message of item.messages) {
      if (payload) seedFields(message, ['role', 'content'], message.role === 'assistant' ? ['toolCalls', 'thinkingBlocks', 'providerContinuation'] : message.role === 'tool' ? ['toolCallId', 'isError'] : [])
      else {
        const descriptors = Object.getOwnPropertyDescriptors(message)
        if (!descriptors.role || !('value' in descriptors.role) || !descriptors.content
          || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !['role', 'content', 'toolCallId', 'isError', 'toolCalls', 'thinkingBlocks', 'providerContinuation'].includes(key))) seedInvalid()
      }
      if (!['user', 'assistant', 'tool'].includes(message.role)) seedInvalid()
      if (payload && typeof message.content !== 'string') {
        if (message.role === 'assistant' || !Array.isArray(message.content)) seedInvalid()
        for (const part of message.content) {
          seedFields(part, part.type === 'text' ? ['type', 'text'] : ['type', 'image'])
          if (part.type === 'text' ? typeof part.text !== 'string' : part.type !== 'image') seedInvalid()
          if (part.type === 'image') { seedFields(part.image, ['mediaType', 'dataBase64'], ['attachmentId', 'name', 'width', 'height']); validateImages([part.image], 'semantic seed') }
        }
      }
      if (message.role === 'tool' && (!seedId(message.toolCallId) || message.isError !== undefined && message.isError !== true)) seedInvalid()
      if (message.role === 'assistant') {
        if (message.toolCalls !== undefined) { if (!Array.isArray(message.toolCalls)) seedInvalid(); for (const call of message.toolCalls) {
          if (payload) seedFields(call, ['id', 'name', 'args'])
          else { seedFields({ id: call.id, name: call.name }, ['id', 'name']); if (!Object.hasOwn(call, 'args')) seedInvalid() }
          if (!seedId(call.id) || !seedId(call.name)) seedInvalid()
        } }
        if (payload) { validateSeedNative(message); validateNativeWitness({ type: 'assistant/message', text: message.content, ...message } as never, 11) }
      }
    }
    const media = (refs: readonly { message: number; part: number }[]) => {
      if (!Array.isArray(refs)) seedInvalid()
      for (const ref of refs) { seedFields(ref, ['message', 'part']); const message = item.messages[ref.message]; if (!seedCount(ref.message) || !seedCount(ref.part) || !message || payload && (!Array.isArray(message.content) || message.content[ref.part]?.type !== 'image')) seedInvalid() }
    }
    if (payload) {
      const actual = item.messages.flatMap((message, index) => Array.isArray(message.content) ? message.content.flatMap((part: import('../projection/types.ts').LLMContentPart, position: number) => part.type === 'image' ? [`${index}:${position}`] : []) : [])
      const claimed = item.kind === 'input' ? item.input.media : item.kind === 'exchange' ? item.results.flatMap(result => result.media) : []
      const keys = claimed.map(ref => `${ref.message}:${ref.part}`)
      if (actual.length !== keys.length || new Set(keys).size !== keys.length || actual.some(key => !keys.includes(key))) seedInvalid()
    }
    if (item.kind !== 'exchange') {
      if (item.messages.some(message => message.role !== 'user')) seedInvalid()
      if (item.kind === 'summary' && (item.messages.length !== 1 || payload && typeof item.messages[0]!.content !== 'string')) seedInvalid()
      if (item.kind === 'input') {
        seedFields(item.input, ['raw', 'derivedContext', 'media'], ['omittedWork']); addresses(item.input.raw); addresses(item.input.derivedContext); media(item.input.media)
        if (item.input.omittedWork !== undefined && (!seedCount(item.input.omittedWork) || item.input.omittedWork >= seed.omissions.length)) seedInvalid()
      }
      return
    }
    if (!['explicit', 'legacy-inferred', 'inherited-observation'].includes(item.sourceAcceptance) || !Array.isArray(item.calls) || !Array.isArray(item.results)) seedInvalid()
    const pending = new Set<string>()
    for (const message of item.messages) {
      if (message.role === 'assistant') { if (pending.size) seedInvalid(); for (const call of message.toolCalls ?? []) pending.add(call.id) }
      else if (message.role === 'tool') { if (!pending.delete(message.toolCallId)) seedInvalid() }
      else if (pending.size) seedInvalid()
    }
    if (pending.size) seedInvalid()
    const calls = new Set<string>(), paired = new Set<number>(), positions = new Set<string>()
    for (const call of item.calls) {
      seedFields(call, ['id', 'name', 'assistantMessage', 'call', 'result', 'outcome', 'source']); addresses(call.source)
      if (![call.assistantMessage, call.call, call.result].every(seedCount) || !['success', 'error', 'not-dispatched'].includes(call.outcome)) seedInvalid()
      const message = item.messages[call.assistantMessage], actual = message?.role === 'assistant' ? message.toolCalls?.[call.call] : undefined
      const result = item.results[call.result], resultMessage = result && item.messages[result.message]
      if (!actual || actual.id !== call.id || actual.name !== call.name || calls.has(call.id) || paired.has(call.result) || !resultMessage || resultMessage.role !== 'tool' || resultMessage.toolCallId !== call.id || result!.message <= call.assistantMessage) seedInvalid()
      const legacyError = (resultMessage as { isError?: true }).isError === true
      if (result!.kind === 'legacy' ? call.outcome !== (legacyError ? 'error' : 'success') && !(legacyError && call.outcome === 'not-dispatched')
        : call.outcome !== (result!.execution.dispatch === 'not-dispatched' ? 'not-dispatched' : result!.execution.outcome === 'succeeded' ? 'success' : 'error')) seedInvalid()
      calls.add(call.id); paired.add(call.result); positions.add(`${call.assistantMessage}:${call.call}`)
    }
    if (paired.size !== item.results.length) seedInvalid()
    for (const [index, message] of item.messages.entries()) {
      if (message.role === 'assistant' && message.toolCalls?.some((_: unknown, call: number) => !positions.has(`${index}:${call}`))) seedInvalid()
      if (message.role === 'tool' && !item.results.some(result => result.message === index)) seedInvalid()
    }
    for (const result of item.results) {
      seedFields(result, ['kind', 'message', 'source', 'media', ...(result.kind === 'envelope' ? ['execution', 'sourceRetention'] : [])], result.kind === 'legacy' ? ['isError'] : ['dependencies'])
      if (!seedCount(result.message) || item.messages[result.message]?.role !== 'tool') seedInvalid()
      addresses(result.source); media(result.media)
      if (result.kind === 'legacy') { if (result.isError !== undefined && result.isError !== true || !!result.isError !== !!(item.messages[result.message] as { isError?: true }).isError) seedInvalid(); continue }
      if (result.kind !== 'envelope') seedInvalid()
      seedFields(result.execution, ['outcome', 'dispatch'])
      if (!['succeeded', 'failed', 'canceled'].includes(result.execution.outcome) || !['dispatched', 'not-dispatched'].includes(result.execution.dispatch)) seedInvalid()
      const retention = result.sourceRetention
      seedFields(retention, ['kind', ...(retention.kind === 'inline-observation' ? ['encodedBytes'] : retention.kind === 'artifact' ? ['artifact'] : ['reason'])], retention.kind === 'inline-observation' ? ['sourceValueDigest'] : retention.kind === 'unavailable' ? ['observedEncodedBytes'] : [])
      if (retention.kind === 'artifact') artifact(retention.artifact, { kind: 'result' })
      else if (retention.kind === 'inline-observation') { if (!seedCount(retention.encodedBytes) || retention.sourceValueDigest !== undefined && !seedDigest(retention.sourceValueDigest)) seedInvalid() }
      else if (retention.kind !== 'unavailable' || !reasons.includes(retention.reason) || retention.observedEncodedBytes !== undefined && !seedCount(retention.observedEncodedBytes)) seedInvalid()
      if (result.dependencies) {
        const dep = result.dependencies
        seedFields(dep, ['kind', 'count', dep.kind === 'catalog' ? 'artifact' : 'reason'])
        if (!seedCount(dep.count) || !dep.count) seedInvalid()
        if (dep.kind === 'catalog') artifact(dep.artifact, { kind: 'dependency-catalog', count: dep.count })
        else if (dep.kind !== 'unavailable' || !reasons.includes(dep.reason)) seedInvalid()
      }
    }
  }
  const identities = new Map<string, string>()
  for (const [index, artifact] of seed.artifacts.entries()) {
    seedFields(artifact, ['ref', 'origins', 'uses']); addresses(artifact.origins)
    if (!validManagedArtifactRef(artifact.ref) || !Array.isArray(artifact.uses) || !artifact.uses.length) seedInvalid()
    const identity = `${artifact.ref.id}:${artifact.ref.revision}`, encoded = canonicalJsonData(artifact.ref)
    if (identities.has(identity)) seedInvalid()
    identities.set(identity, encoded)
    const expected = used.get(index)
    let catalogCount: number | undefined
    const actual = new Set(artifact.uses.map(use => {
      seedFields(use, use.kind === 'result' ? ['kind'] : ['kind', 'count'])
      if (use.kind !== 'result' && (use.kind !== 'dependency-catalog' || !seedCount(use.count) || !use.count || artifact.ref.codec !== 'json-utf8-v1')) seedInvalid()
      if (use.kind === 'dependency-catalog') {
        if (catalogCount !== undefined && catalogCount !== use.count) seedInvalid()
        catalogCount = use.count
      }
      return canonicalJsonData(use)
    }))
    if (actual.size !== artifact.uses.length || (partial ? expected && [...expected].some(use => !actual.has(use))
      : !expected || actual.size !== expected.size || [...actual].some(use => !expected.has(use)))) seedInvalid()
  }
  if (payload && !partial) {
    const origin = seed.origins[0]!, expected = seedHash(semanticSourceDomain(seed), seedPreimage(seed))
    if ((origin.kind === 'session' ? origin.revision : origin.contentDigest) !== expected) seedInvalid()
  }
  if (seed.version === 3) validateSelectedResultsTable(seed, partial)
  return seed
}
