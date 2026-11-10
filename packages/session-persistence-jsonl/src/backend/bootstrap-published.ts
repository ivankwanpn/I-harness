import { canonicalJsonData, decodeFactBatch, legacyPrefixDigest } from '@i-harness/core-session'
import { bootstrapManifest, parseBootstrapHeaderStage, routeInvocation, routeForReservation, validateOwnedCaptureStage, type BootstrapRoute, type BootstrapHeaderOperation, type BootstrapReadState } from '@i-harness/session-persistence'

const conflict = (): never => { throw Object.assign(new Error('Published bootstrap prefix conflict'), { code: 'BOOTSTRAP_PUBLISHED_CONFLICT' }) }

/** Validates copied bootstrap bytes. The constructor-owned reader binds them
 * to the actual held namespace. */
export function capturePublishedBootstrap(route: BootstrapRoute, operation: BootstrapHeaderOperation, seedBytes?: Uint8Array) {
  const stageBytes = Buffer.from(operation.stageBytes), headerBytes = Buffer.from(operation.headerBytes)
  const stage = parseBootstrapHeaderStage(stageBytes), invocation = routeInvocation(route)
  if (canonicalJsonData(stage.invocation) !== canonicalJsonData(invocation)
    || canonicalJsonData(operation.invocation) !== canonicalJsonData(invocation)
    || canonicalJsonData(operation.target) !== canonicalJsonData(stage.originalTarget)
    || stage.headerBase.formatVersion !== 14 || !headerBytes.equals(Buffer.from(stage.headerBytes))) conflict()
  const expectedRoute: BootstrapRoute = stage.captureReservation ? routeForReservation(stage.captureReservation) : { protocol: 'public', invocation: stage.invocation }
  if (canonicalJsonData(route) !== canonicalJsonData(expectedRoute)) conflict()
  const seed = seedBytes === undefined ? undefined : Buffer.from(seedBytes)
  const decoded = seed ? decodeFactBatch(seed) : undefined
  const empty = { eventCount: 0, bodyBytes: 0, prefixDigest: legacyPrefixDigest(0, new Uint8Array()) }
  if (stage.seed.seedLength > 0) {
    if (!decoded || decoded.key.batchId !== 'bootstrap:' + invocation.operationId + ':seed'
      || decoded.key.firstSeq !== 0 || decoded.key.count !== stage.seed.seedLength
      || decoded.key.previousPrefixDigest !== empty.prefixDigest) conflict()
  } else if (decoded) conflict()
  const records = (decoded?.events ?? []).map(event => {
    if (event.type === 'conversation/seed-group') return event
    if (event.type === 'conversation/seed-manifest' && (event.version === 1 || event.version === 2)) return event
    return conflict()
  })
  const header = JSON.parse(stage.headerBytes)
  if (bootstrapManifest(stage, records) !== header.semanticSeed.manifestDigest) conflict()
  if (stage.captureReservation) validateOwnedCaptureStage(stage.captureReservation, stage, records)
  const seeded = decoded && seed ? { eventCount: decoded.key.count, bodyBytes: seed.length, prefixDigest: decoded.prefixDigest } : undefined
  return Object.freeze({
    check(state: BootstrapReadState): string {
      if (state.kind !== 'present') { if (state.foreign) conflict(); throw new Error('Published bootstrap read unavailable') }
      if (state.foreign || state.captureReservation || !state.stagePresent || !state.stageBytes
        || !Buffer.from(state.stageBytes).equals(stageBytes) || state.promotionPresent
        || state.rawHeader !== stage.headerBytes || state.meta?.formatVersion !== 14
        || !state.events || !state.prefix || !state.frames) return conflict()
      if (state.publicationPresent && (stage.originalTarget.kind === 'new' || !state.publicationBytes || !Buffer.from(state.publicationBytes).equals(headerBytes))) conflict()
      if (state.events.length === 0) {
        if (state.frames.length || canonicalJsonData(state.prefix) !== canonicalJsonData(empty)) conflict()
      } else {
        if (!seed || !seeded || state.events.length !== stage.seed.seedLength || state.frames.length !== 1
          || !Buffer.from(state.frames[0]!.batch.bytes).equals(seed)
          || canonicalJsonData(state.frames[0]!.prefix) !== canonicalJsonData(empty)
          || canonicalJsonData(state.prefix) !== canonicalJsonData(seeded)) conflict()
      }
      return canonicalJsonData({ header: state.rawHeader, stage: stageBytes.toString('base64'), prefix: state.prefix, torn: !!state.torn, publication: state.publicationBytes ? Buffer.from(state.publicationBytes).toString('base64') : null })
    },
  })
}
