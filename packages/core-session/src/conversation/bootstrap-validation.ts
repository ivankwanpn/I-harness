import type { SessionEventView } from '../managed/types.ts'
import type { SeedHeaderV1 } from '../events/bootstrap.ts'
import type { GenerationHistoryScope } from './generation.ts'
import { canonicalJsonData } from '../serialization/json-data.ts'
import { seedCount, seedData, seedDigest, seedFields, seedId, seedInvalid, validateSemanticSeed, validateSemanticSeedStructure, validateSemanticSeedPrefix } from './seed-codec.ts'
import { seedHash, EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from './seed-digest.ts'
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

export function validateSeedHeader(header: SeedHeaderV1): void {
  seedData(header)
  seedFields(header, ['version', 'codec', 'operationId', 'requestDigest', 'manifestDigest', 'seedDigest', 'dependencyDigest', 'seedLength', 'groupCount'],
    ['initialInputId', 'initialInputDigest', 'initialStartedAt', 'initialExpiresAt'])
  if (header.version !== 1 || header.codec !== 'semantic-seed-v1' || !seedId(header.operationId)
    || ![header.requestDigest, header.manifestDigest, header.seedDigest, header.dependencyDigest].every(seedDigest)
    || !seedCount(header.seedLength) || !seedCount(header.groupCount) || (header.seedLength === 0 ? header.groupCount !== 0 : header.seedLength !== header.groupCount + 1)) seedInvalid()
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
  if (!['conversation/seed-manifest', 'conversation/seed-group', 'session/bootstrap'].includes(event.type)) return
  if (formatVersion < 11) seedInvalid()
  if (payload) seedData(event)
  if (event.type === 'conversation/seed-manifest') {
    seedFields(event, ['type', 'version', 'seq', 'codec', 'digest', 'groupCount', 'origins', 'selection', 'turns', 'omissions', 'artifacts'])
    if (event.version !== 1 || event.seq !== 0 || event.codec !== 'semantic-seed-v1' || !seedDigest(event.digest) || !seedCount(event.groupCount)) seedInvalid()
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
    if (events.some(event => ['conversation/seed-manifest', 'conversation/seed-group', 'session/bootstrap'].includes(event.type))) seedInvalid()
    return
  }
  validateSeedHeader(header)
  if (formatVersion !== 11 || scope.seedLength !== header.seedLength) seedInvalid()
  for (const [position, event] of events.entries()) {
    if (capability === semanticSourceStructure) validateSeedSourceEventShape(event, formatVersion)
    else validateSeedEventShape(event, formatVersion)
    if (position < header.seedLength) {
      if (event.seq !== position || (position === 0 ? event.type !== 'conversation/seed-manifest' : event.type !== 'conversation/seed-group')) seedInvalid()
      if (event.type === 'conversation/seed-manifest' && (event.digest !== header.seedDigest || event.groupCount !== header.groupCount)) seedInvalid()
      if (event.type === 'conversation/seed-group' && event.ordinal !== position - 1) seedInvalid()
    } else if (position === header.seedLength) {
      if (event.type !== 'session/bootstrap' || event.seq !== position || event.operationId !== header.operationId || event.manifestDigest !== header.manifestDigest
        || event.seedLength !== header.seedLength || event.initialInputId !== header.initialInputId || event.initialStartedAt !== header.initialStartedAt || event.initialExpiresAt !== header.initialExpiresAt) seedInvalid()
    } else {
      if (['conversation/seed-manifest', 'conversation/seed-group', 'session/bootstrap'].includes(event.type)) seedInvalid()
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
    if (manifest?.type === 'conversation/seed-manifest') validateSemanticSeedPrefix({ version: 1, origins: manifest.origins, selection: manifest.selection, turns: manifest.turns,
      omissions: manifest.omissions, artifacts: manifest.artifacts, groups: events.slice(1, header.seedLength).map(event => { if (event.type !== 'conversation/seed-group') seedInvalid(); return event.group }) })
    return
  }
  if (header.seedLength) {
    const manifest = events[0]
    if (manifest?.type !== 'conversation/seed-manifest') seedInvalid()
    const groups = events.slice(1, header.seedLength).map(record => { if (record.type !== 'conversation/seed-group') seedInvalid(); return record.group })
    const data = { version: 1, origins: manifest.origins, selection: manifest.selection, turns: manifest.turns, omissions: manifest.omissions, artifacts: manifest.artifacts, groups }
    if (capability === semanticSourceStructure) validateSemanticSeedStructure(data)
    else {
      const seed = validateSemanticSeed(data)
      if (seedHash('ih.semantic-seed.v1', seed) !== header.seedDigest || seedHash('ih.semantic-seed.dependencies.v1', seed.artifacts) !== header.dependencyDigest) seedInvalid()
    }
  }
}
/** All reservation scalars participate, including absence, under one owner. */
export function conversationScopeKey(header: GenerationHistoryScope = {}): string {
  if (header.semanticSeed) validateSeedHeader(header.semanticSeed)
  return canonicalJsonData([header.sessionId ?? null, header.parentSession ?? null, header.seedLength ?? null, header.semanticSeed ?? null])
}
