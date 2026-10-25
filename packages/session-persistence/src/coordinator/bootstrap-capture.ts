import { canonicalJsonData, freezeJsonData, isStrictFactData } from '@i-harness/core-session'
import { readForkRequestCore } from '../fork-contract.ts'
import { bootstrapFields, captureBootstrapInvocation, sameBootstrapData } from './bootstrap-header.ts'
import { captureBootstrapRequestIntent, createBootstrapRequestIntent } from './bootstrap-intent.ts'
import type { BootstrapCaptureRequest, BootstrapCaptureReservation, BootstrapHeaderStage, BootstrapRequest } from './bootstrap-types.ts'

export function captureBootstrapCaptureRequest(input: unknown): BootstrapCaptureRequest {
  bootstrapFields(input, ['invocation', 'core', 'requestIntent'])
  if (!isStrictFactData(input)) throw new TypeError('Invalid capture request')
  const invocation = captureBootstrapInvocation(input.invocation), core = readForkRequestCore(input.core)
  const requestIntent = captureBootstrapRequestIntent(invocation, input.requestIntent)
  const expected = createBootstrapRequestIntent(core, requestIntent.project)
  if (!sameBootstrapData(expected.intent, requestIntent) || expected.requestDigest !== invocation.requestDigest || invocation.targetSessionId === core.sourceSessionId || /[\\/\u0000-\u001f\u007f]/.test(invocation.targetSessionId) || invocation.targetSessionId.includes('..')) throw new TypeError('Capture binding mismatch')
  return Object.freeze({ invocation, core, requestIntent })
}
export function encodeBootstrapCaptureReservation(value: BootstrapCaptureReservation): Uint8Array {
  bootstrapFields(value, ['version', 'kind', 'request'])
  if (value.version !== 1 || value.kind !== 'semantic-bootstrap-capture') throw new TypeError('Invalid capture reservation')
  const request = captureBootstrapCaptureRequest(value.request)
  const bytes = Buffer.from(canonicalJsonData({ version: 1, kind: 'semantic-bootstrap-capture', request }) + '\n')
  if (bytes.length > 262144) throw new TypeError('Capture reservation exceeds stage limit')
  return bytes
}
export function parseBootstrapCaptureReservation(bytes: Uint8Array): BootstrapCaptureReservation {
  if (bytes.length > 262144) throw new TypeError('Capture reservation exceeds stage limit')
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as BootstrapCaptureReservation
  if (!Buffer.from(encodeBootstrapCaptureReservation(value)).equals(Buffer.from(bytes))) throw new TypeError('Noncanonical capture reservation')
  return freezeJsonData(value) as BootstrapCaptureReservation
}
export function validateCaptureStage(reservation: BootstrapCaptureReservation, stage: BootstrapHeaderStage, records?: BootstrapRequest['seed']['records']) {
  const r = parseBootstrapCaptureReservation(encodeBootstrapCaptureReservation(reservation)), core = r.request.core
  if (!sameBootstrapData(r.request.invocation, stage.invocation) || stage.originalTarget.kind !== 'new' || !sameBootstrapData(core.metadata, stage.metadata) || stage.lineage.origin !== 'fork' || stage.lineage.parentSession !== core.sourceSessionId || stage.seed.sourceObservation.kind !== 'semantic' || stage.seed.seedLength < 1 || stage.initial) throw new TypeError('Capture stage binding mismatch')
  if (records) {
    const manifest = records[0]
    if (manifest?.type !== 'conversation/seed-manifest' || manifest.origins[0]?.kind !== 'session' || manifest.origins[0].sessionId !== core.sourceSessionId || !sameBootstrapData(manifest.selection, core.selection)) throw new TypeError('Captured source selection mismatch')
  }
}
