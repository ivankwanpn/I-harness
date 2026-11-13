import { originalEmptyTarget } from './bootstrap-stage.ts'
import { canonicalJsonData, decodeFactBatch, legacyPrefixDigest } from '@i-harness/core-session'
import { bootstrapManifest, parseBootstrapHeaderStage, routeInvocation, routeForReservation, validateOwnedCaptureStage, type BootstrapRoute, type BootstrapHeaderOperation, type BootstrapReadState } from '@i-harness/session-persistence'

const conflict = (): never => { throw Object.assign(new Error('Published bootstrap prefix conflict'), { code: 'BOOTSTRAP_PUBLISHED_CONFLICT' }) }

/** Validates copied bootstrap bytes. The constructor-owned reader binds them
 * to the actual held namespace. */
export function capturePublishedBootstrap(route: BootstrapRoute, operation: BootstrapHeaderOperation, seedBytes?: Uint8Array, completionLimit?: number) {
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
  if (completionLimit !== undefined && (!Number.isSafeInteger(completionLimit) || completionLimit <= 0)) conflict()
  return Object.freeze({
    check(state: BootstrapReadState, target: Uint8Array | undefined, actualStage: Uint8Array | undefined, publication: Uint8Array | undefined): string {
      if (state.foreign || state.promotionPresent) conflict()
      if (actualStage === undefined) return conflict()
      const actual = Buffer.from(actualStage)
      const captured = !!stage.captureReservation
      // Generic recovery needs a discriminating original header-stage prefix.
      // Empty/common prefixes cannot prove this was not a spent capture.
      const genericPrefix = Buffer.from('{"headerBase":')
      if (!captured && (actual.length < genericPrefix.length || !actual.subarray(0,genericPrefix.length).equals(genericPrefix))) conflict()
      if (captured ? !actual.equals(stageBytes) : actual.length > stageBytes.length || !actual.equals(stageBytes.subarray(0,actual.length))) conflict()
      const bytes = target && Buffer.from(target)
      const expected = Buffer.concat([headerBytes, ...(seed ? [seed] : [])])
      const preimage = !!bytes && originalEmptyTarget(bytes,invocation.targetSessionId,operation)
      if (bytes && !preimage) {
        if (bytes.length <= expected.length) {
          if (!bytes.equals(expected.subarray(0,bytes.length))) conflict()
        } else {
          // This tail is an observation, never a receipt or history grant.
          // Original journal reconciliation alone may validate and truncate it.
          const tail = bytes.subarray(expected.length)
          if (!completionLimit || !bytes.subarray(0,expected.length).equals(expected)
            || tail.length >= completionLimit || tail.includes(10) || !state.torn
            || state.events?.length !== stage.seed.seedLength
            || state.frames?.length !== (seed ? 1 : 0)) conflict()
        }
      }
      if (publication) {
        if (stage.originalTarget.kind !== 'existing-empty') conflict()
        const published = Buffer.from(publication)
        if (published.length > headerBytes.length || !published.equals(headerBytes.subarray(0,published.length))) conflict()
        if (!preimage && (!bytes || !bytes.equals(headerBytes))) conflict()
      }
      return canonicalJsonData({ stage:actual.toString('base64'),target:bytes?.toString('base64') ?? null,publication:publication ? Buffer.from(publication).toString('base64') : null })
    },
  })
}
