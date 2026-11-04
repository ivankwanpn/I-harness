import type { SessionEventView } from '../managed/types.ts'
import type { SeedHeader } from '../events/bootstrap.ts'
import type { GenerationHistoryScope } from './generation.ts'
import { canonicalJsonData } from '../serialization/json-data.ts'
import { seedCount, seedData, seedDigest, seedFields, seedId, seedInvalid, validateSemanticSeed, validateSemanticSeedStructure, validateSemanticSeedPrefix, semanticSeedFromRecords, validateSelectedResultsRecordPrefix } from './seed-codec.ts'
import { seedHash, semanticSeedDomain, semanticDependencyDigest, EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from './seed-digest.ts'
import { seedLayout } from './seed-layout.ts'
import { validateResultsSummary } from './selected-results-codec.ts'
import { validateAdmitted, type AdmittedInput } from '../inbox.ts'
import { validateConversationEventShape } from '../events/conversation.ts'
import { bootstrapInitialInputDigest } from './bootstrap-initial.ts'

// This capability stays inside the internal composition path. Public index and
// projection factories never accept it, nor any JSON/header readiness toggle.
export const bootstrapStaging = Symbol('core-session bootstrap staging')
export const semanticSourceStructure = Symbol('core-session semantic source structure')
const incomplete = (): never => { throw Object.assign(new Error('bootstrap-incomplete'), { code: 'SESSION_BOOTSTRAP_INCOMPLETE' }) }

/** Strict public writer boundary for the new seed invariants only. Ordinary
 * legacy cross-event semantics remain with their existing validation owners. */
export function validateSemanticBootstrapHistory(events: readonly SessionEventView[], formatVersion: number, header: GenerationHistoryScope = {}): void {
  validateBootstrapReadiness(events, formatVersion, header)
}

/** S-06 step 2: validate only the events being appended. The caller guarantees
 * that the existing prefix was already validated for this exact file extent
 * (the backend journal cache), so the per-append cost is O(added), not
 * O(history). Positions below seedLength cannot be appended. */
export function validateSemanticBootstrapAppend(prefixCount: number, added: readonly SessionEventView[], formatVersion: number, scope: GenerationHistoryScope = {}): void {
  const header = scope.semanticSeed
  const seedTypes = ['conversation/seed-manifest', 'conversation/seed-results', 'conversation/seed-group', 'session/bootstrap']
  if (!header) { if (added.some(event => seedTypes.includes(event.type))) seedInvalid(); return }
  validateSeedHeader(header)
  const layout = seedLayout(header)
  if (![11, 12, 13, 14].includes(formatVersion) || scope.seedLength !== header.seedLength) seedInvalid()
  for (const [index, event] of added.entries()) {
    const position = prefixCount + index
    validateSeedEventShape(event, formatVersion)
    if (position < header.seedLength) seedInvalid()
    else if (position === header.seedLength) {
      if (event.type !== 'session/bootstrap' || event.seq !== position || event.operationId !== header.operationId || event.manifestDigest !== header.manifestDigest
        || event.seedLength !== header.seedLength || event.initialInputId !== header.initialInputId || event.initialStartedAt !== header.initialStartedAt || event.initialExpiresAt !== header.initialExpiresAt) seedInvalid()
    } else {
      if (seedTypes.includes(event.type)) seedInvalid()
      if (position === header.seedLength + 1 && header.initialInputId !== undefined) {
        if (event.type !== 'agent/input/admitted' || event.inputId !== header.initialInputId || event.seq !== position) seedInvalid()
        seedData(event)
        seedFields(event, ['type', 'version', 'seq', 'inputId', 'text', 'delivery', 'intent'], ['provenance', 'preparationPolicy', 'supplementalContext', 'synthetic', 'images', 'clientToken'])
        validateConversationEventShape(event, formatVersion)
        validateAdmitted(event as unknown as AdmittedInput)
        if (bootstrapInitialInputDigest(event, header.initialStartedAt!, header.initialExpiresAt!) !== header.initialInputDigest) seedInvalid()
      }
    }
    void layout
  }
}

export function validateSeedHeader(header: SeedHeader): void {
  seedData(header)
  seedFields(header, ['version', 'codec', 'operationId', 'requestDigest', 'manifestDigest', 'seedDigest', 'dependencyDigest', 'seedLength', 'groupCount', ...(header.version === 3 ? ['profile', 'results', 'resultPageCount'] : [])],
    ['initialInputId', 'initialInputDigest', 'initialStartedAt', 'initialExpiresAt'])
  if (!(header.version === 1 && header.codec === 'semantic-seed-v1' || header.version === 2 && header.codec === 'semantic-seed-v2' && header.seedLength > 0 || header.version === 3 && header.codec === 'semantic-seed-v3' && header.seedLength > 0) || !seedId(header.operationId)
    || ![header.requestDigest, header.manifestDigest, header.seedDigest, header.dependencyDigest].every(seedDigest)
    || !seedCount(header.seedLength) || !seedCount(header.groupCount) || (header.seedLength === 0 ? header.groupCount !== 0 : header.seedLength !== seedLayout(header).seedLength)) seedInvalid()
  if (header.version === 3) { if (!['public-completed', 'child-history'].includes(header.profile)) seedInvalid(); validateResultsSummary(header.results); seedLayout(header) }
  if (header.seedLength === 0 && (header.seedDigest !== EMPTY_SEMANTIC_SEED_DIGEST || header.dependencyDigest !== EMPTY_SEMANTIC_DEPENDENCY_DIGEST)) seedInvalid()
  const initial = [header.initialInputId, header.initialInputDigest, header.initialStartedAt, header.initialExpiresAt]
  if (initial.some(value => value !== undefined) && (!seedId(header.initialInputId) || !seedDigest(header.initialInputDigest)
    || !seedCount(header.initialStartedAt) || !seedCount(header.initialExpiresAt) || header.initialExpiresAt <= header.initialStartedAt)) seedInvalid()
}
export function validateSeedEventShape(event: SessionEventView, formatVersion: number): void {
  seedEventShape(event, formatVersion, true)
}
export function validateSeedSourceEventShape(event: SessionEventView, formatVersion: number): void {
  seedEventShape(event, formatVersion, false)
}
function seedEventShape(event: SessionEventView, formatVersion: number, payload: boolean): void {
  if (!['conversation/seed-manifest', 'conversation/seed-results', 'conversation/seed-group', 'session/bootstrap'].includes(event.type)) return
  if (formatVersion < 11) seedInvalid()
  if (payload) seedData(event)
  if (event.type === 'conversation/seed-manifest') {
    seedFields(event, ['type', 'version', 'seq', 'codec', 'digest', 'groupCount', 'origins', 'selection', 'turns', 'omissions', 'artifacts', ...(event.version === 3 ? ['profile', 'results', 'resultPageCount'] : []), ...(event.version === 2 || event.version === 3 && event.profile === 'public-completed' ? ['passive'] : [])])
    if (!(event.version === 1 && event.codec === 'semantic-seed-v1' || event.version === 2 && event.codec === 'semantic-seed-v2' || event.version === 3 && event.codec === 'semantic-seed-v3') || event.seq !== 0 || !seedDigest(event.digest) || !seedCount(event.groupCount)) seedInvalid()
    if (event.version === 3) { if (!['public-completed', 'child-history'].includes(event.profile)) seedInvalid(); validateResultsSummary(event.results); seedLayout(event) }
  } else if (event.type === 'conversation/seed-results') {
    seedFields(event, ['type', 'version', 'seq', 'manifestSeq', 'ordinal', 'page'])
    if (event.version !== 1 || !seedCount(event.seq) || event.seq !== 1 + event.ordinal || event.manifestSeq !== 0 || !seedCount(event.ordinal) || event.page.ordinal !== event.ordinal) seedInvalid()
  } else if (event.type === 'conversation/seed-group') {
    seedFields(event, ['type', 'version', 'seq', 'manifestSeq', 'ordinal', 'group'])
    if (event.version !== 1 || !seedCount(event.seq) || event.seq < 1 || event.manifestSeq !== 0 || !seedCount(event.ordinal)) seedInvalid()
  } else if (event.type === 'session/bootstrap') {
    seedFields(event, ['type', 'version', 'seq', 'operationId', 'manifestDigest', 'dependencyClosureDigest', 'seedLength'], ['initialInputId', 'initialStartedAt', 'initialExpiresAt'])
    if (event.version !== 1 || !seedCount(event.seq) || !seedCount(event.seedLength) || !seedId(event.operationId) || !seedDigest(event.manifestDigest) || !seedDigest(event.dependencyClosureDigest)) seedInvalid()
  }
}

export function validateBootstrapReadiness(events: readonly SessionEventView[], formatVersion: number, scope: GenerationHistoryScope, capability?: typeof bootstrapStaging | typeof semanticSourceStructure): void {
  const header = scope.semanticSeed
  if (!header) {
    if (events.some(event => ['conversation/seed-manifest', 'conversation/seed-results', 'conversation/seed-group', 'session/bootstrap'].includes(event.type))) seedInvalid()
    return
  }
  validateSeedHeader(header)
  const layout = seedLayout(header)
  if (![11, 12, 13, 14].includes(formatVersion) || scope.seedLength !== header.seedLength) seedInvalid()
  for (const [position, event] of events.entries()) {
    if (capability === semanticSourceStructure) validateSeedSourceEventShape(event, formatVersion)
    else validateSeedEventShape(event, formatVersion)
    if (position < header.seedLength) {
      if (event.seq !== position || (position === 0 ? event.type !== 'conversation/seed-manifest' : position <= layout.resultPageCount ? event.type !== 'conversation/seed-results' : event.type !== 'conversation/seed-group')) seedInvalid()
      if (event.type === 'conversation/seed-manifest' && (event.version !== header.version || event.codec !== header.codec || event.digest !== header.seedDigest || event.groupCount !== header.groupCount)) seedInvalid()
      if (event.type === 'conversation/seed-group' && event.ordinal !== position - 1 - layout.resultPageCount) seedInvalid()
    } else if (position === header.seedLength) {
      if (event.type !== 'session/bootstrap' || event.seq !== position || event.operationId !== header.operationId || event.manifestDigest !== header.manifestDigest
        || event.seedLength !== header.seedLength || event.initialInputId !== header.initialInputId || event.initialStartedAt !== header.initialStartedAt || event.initialExpiresAt !== header.initialExpiresAt) seedInvalid()
    } else {
      if (['conversation/seed-manifest', 'conversation/seed-results', 'conversation/seed-group', 'session/bootstrap'].includes(event.type)) seedInvalid()
      if (position === header.seedLength + 1 && header.initialInputId !== undefined) {
        if (event.type !== 'agent/input/admitted' || event.inputId !== header.initialInputId || event.seq !== position) seedInvalid()
        seedData(event)
        seedFields(event, ['type', 'version', 'seq', 'inputId', 'text', 'delivery', 'intent'], ['provenance', 'preparationPolicy', 'supplementalContext', 'synthetic', 'images', 'clientToken'])
        validateConversationEventShape(event, formatVersion)
        validateAdmitted(event as unknown as AdmittedInput)
        if (bootstrapInitialInputDigest(event, header.initialStartedAt!, header.initialExpiresAt!) !== header.initialInputDigest) seedInvalid()
      }
    }
  }
  if (events.length < header.seedLength + 1 + (header.initialInputId === undefined ? 0 : 1)) {
    if (capability !== bootstrapStaging) incomplete()
    const manifest = events[0]
    if (header.version === 3) validateSelectedResultsRecordPrefix(header, events.slice(0, header.seedLength))
    else if (manifest?.type === 'conversation/seed-manifest') validateSemanticSeedPrefix(semanticSeedFromRecords(header, events))
    return
  }
  if (header.seedLength) {
    const manifest = events[0]
    if (manifest?.type !== 'conversation/seed-manifest') seedInvalid()
    const data = semanticSeedFromRecords(header, events)
    if (capability === semanticSourceStructure) {
      validateSemanticSeedStructure(data)
      // V3 dependencies commit metadata only, so source readers can verify
      // this binding without visiting any discarded conversation payload.
      if (data.version === 3 && semanticDependencyDigest(data) !== header.dependencyDigest) seedInvalid()
    }
    else {
      const seed = validateSemanticSeed(data)
      if (seedHash(semanticSeedDomain(seed), seed) !== header.seedDigest || semanticDependencyDigest(seed) !== header.dependencyDigest) seedInvalid()
    }
  }
}
/** All reservation scalars participate, including absence, under one owner. */
export function conversationScopeKey(header: GenerationHistoryScope = {}): string {
  if (header.semanticSeed) validateSeedHeader(header.semanticSeed)
  return canonicalJsonData([header.sessionId ?? null, header.parentSession ?? null, header.seedLength ?? null, header.semanticSeed ?? null])
}

/** Original bootstrap readiness across a private scan; payload is retained only
 * until the finite birth has passed its complete original validator. */
export function createBootstrapReadinessScan(formatVersion: number, scope: GenerationHistoryScope) {
  const required = scope.semanticSeed ? scope.semanticSeed.seedLength + 1 + (scope.semanticSeed.initialInputId === undefined ? 0 : 1) : 0
  let count = 0, complete = required === 0
  let prefix: SessionEventView[] = []
  return {
    advance(event: SessionEventView) {
      validateSeedEventShape(event, formatVersion)
      if (!complete) {
        prefix.push(event)
        if (++count === required) { validateBootstrapReadiness(prefix, formatVersion, scope); prefix = []; complete = true }
        return
      }
      if (['conversation/seed-manifest', 'conversation/seed-results', 'conversation/seed-group', 'session/bootstrap'].includes(event.type)) seedInvalid()
      count++
    },
    finish() { if (!complete) incomplete(); if (!required) validateBootstrapReadiness([], formatVersion, scope) },
  }
}

/** A private restored index has already validated its immutable complete birth.
 * Warm appends validate only new original facts; public mutable replay does not
 * use this construction path and continues rechecking its actual birth. */
export function validateCommittedBootstrapSuffix(events: readonly SessionEventView[], formatVersion:number, scope:GenerationHistoryScope, from:number):void {
  if(!scope.semanticSeed){validateBootstrapReadiness(events,formatVersion,scope);return}
  validateSeedHeader(scope.semanticSeed)
  const required=scope.semanticSeed.seedLength+1+(scope.semanticSeed.initialInputId===undefined?0:1)
  if(from<required)incomplete()
  for(const event of events){validateSeedEventShape(event,formatVersion);if(['conversation/seed-manifest','conversation/seed-results','conversation/seed-group','session/bootstrap'].includes(event.type))seedInvalid()}
}
