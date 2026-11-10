import { expect, it } from 'vitest'
import { canonicalJsonData, createSession, exportConversationSeed } from '@i-harness/core-session'
import * as p from '../src/index.ts'
import { compileSelectedResultsSemanticSeed } from '../src/semantic-seed.ts'
import { buildBootstrapHeader, captureBootstrapRequest, parseBootstrapHeaderStage } from '../src/coordinator/bootstrap-header.ts'
import { validateCaptureStage } from '../src/coordinator/bootstrap-capture.ts'
import { validateChildCaptureStage, validateOwnedCaptureStage } from '../src/coordinator/bootstrap-route.ts'
import { preparationFacts } from '../src/coordinator/bootstrap-preparation-facts.ts'
import { codecSeed, codecWire, sealCodecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import { pair } from './child-bootstrap-fixture.ts'

function legacyRequest(): p.BootstrapRequest {
  const exported = exportConversationSeed(createSession(), { kind: 'session', sessionId: 'source' }, { kind: 'all' })
  if (exported.kind !== 'seed') throw Error('legacy fixture')
  return { invocation: { version: 1, operationId: 'deny', targetSessionId: 'target', createdAt: '2026-10-28T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'source' }, seed: p.compileSemanticSeed(exported) }
}
function withV3Header(stage: p.BootstrapHeaderStage, exported: any): p.BootstrapHeaderStage {
  const compiled = compileSelectedResultsSemanticSeed(exported), wire = codecWire(exported), meta = JSON.parse(stage.headerBytes)
  const old = meta.semanticSeed
  meta.seedLength = wire.header.seedLength
  meta.semanticSeed = { ...wire.header.semanticSeed, operationId: old.operationId, requestDigest: old.requestDigest, manifestDigest: old.manifestDigest,
    ...(stage.initial ? { initialInputId: stage.initial.inputId, initialInputDigest: stage.initial.digest, initialStartedAt: stage.initial.startedAt, initialExpiresAt: stage.initial.expiresAt } : {}) }
  return { ...stage, headerBase: { ...stage.headerBase, seedLength: meta.seedLength }, seed: { digest: compiled.digest, dependencyDigest: compiled.dependencyDigest,
    sourceObservation: compiled.sourceObservation, seedLength: wire.header.seedLength, groupCount: exported.seed.groups.length }, headerBytes: canonicalJsonData(meta) + '\n' }
}
it.each(['public-completed', 'child-history'])('parses zero-page V3 %s data without authorizing a legacy writer or source capture', profile => {
  const exported = codecSeed(profile), original = legacyRequest(), v3: any = { ...original, seed: compileSelectedResultsSemanticSeed(exported) }
  expect(() => p.compileSemanticSeed(exported)).toThrow('Legacy semantic seed')
  expect(captureBootstrapRequest(v3)).toEqual(v3)
  expect(() => buildBootstrapHeader(v3)).not.toThrow()
  const stage = withV3Header(buildBootstrapHeader(original).stage, exported)
  expect(() => parseBootstrapHeaderStage(Buffer.from(canonicalJsonData(stage) + '\n'))).toThrow('Invalid bootstrap materialization')
  expect(() => preparationFacts(stage, codecWire(exported).records)).toThrow('Legacy preparation facts')
  const core = p.readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {} })
  const intent = p.createBootstrapRequestIntent(core, { kind: 'unmanaged' })
  const reservation = { version: 1 as const, kind: 'semantic-bootstrap-capture' as const, request: { invocation: { ...original.invocation, requestDigest: intent.requestDigest }, core, requestIntent: intent.intent } }
  const captureStage = withV3Header(buildBootstrapHeader({ ...original, invocation: reservation.request.invocation }).stage, exported)
  expect(() => validateCaptureStage(reservation, captureStage)).toThrow('Legacy public seed')
  expect(captureBootstrapRequest(original)).toEqual(original)
})
it('denies V3 public capture headers and supplied manifests before accepting original source/selection bindings', () => {
  const original = legacyRequest(), core = p.readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {} })
  const intent = p.createBootstrapRequestIntent(core, { kind: 'unmanaged' }), invocation = { ...original.invocation, requestDigest: intent.requestDigest }
  const reservation = { version: 1 as const, kind: 'semantic-bootstrap-capture' as const, request: { invocation, core, requestIntent: intent.intent } }
  const stage = withV3Header(buildBootstrapHeader({ ...original, invocation }).stage, codecSeed('public-completed'))
  expect(() => validateCaptureStage(reservation, stage)).toThrow('Legacy public seed')
  expect(() => validateCaptureStage(reservation, { ...stage, headerBytes: '' }, codecWire(codecSeed('public-completed')).records)).toThrow('Captured source selection')
  expect(() => validateOwnedCaptureStage({ ...reservation, kind: 'future' } as any, stage)).toThrow('Unknown capture reservation')
})
it('denies child V3 header-only capture and V3 manifests while preserving the old none and V1 paths', () => {
  const values = pair(), exported = exportConversationSeed(createSession(), { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
  if (exported.kind !== 'seed') throw Error('V1 fixture')
  const core = { ...values.request.core, history: { selection: { kind: 'all' as const }, source: { kind: 'session' as const, sessionId: 'parent' } } }
  const intent = p.createChildBootstrapRequestIntent(core, { kind: 'unmanaged' })
  const request = p.captureChildBootstrapCaptureRequest({ ...values.request, core, requestIntent: intent.intent, invocation: { ...values.request.invocation, requestDigest: intent.requestDigest } })
  const payload = { ...values.payload, invocation: request.invocation, seed: p.compileSemanticSeed(exported) }
  const reservation = { version: 1 as const, kind: 'semantic-bootstrap-child-capture' as const, request }, legacy = buildBootstrapHeader(payload, undefined, undefined, reservation).stage
  expect(() => validateChildCaptureStage(reservation, legacy)).not.toThrow()
  const draft = codecSeed(); draft.seed.origins[0].sessionId = 'parent'; const v3 = sealCodecSeed(draft.seed)
  const stage = withV3Header(legacy, v3)
  expect(() => validateChildCaptureStage(reservation, stage)).toThrow('Child V1 seed required')
  expect(() => validateChildCaptureStage(reservation, stage, codecWire(v3).records)).toThrow('Child source selection')
  const none = { version: 1 as const, kind: 'semantic-bootstrap-child-capture' as const, request: values.request }
  expect(() => validateChildCaptureStage(none, buildBootstrapHeader(values.payload, undefined, undefined, none).stage, [])).not.toThrow()
})
