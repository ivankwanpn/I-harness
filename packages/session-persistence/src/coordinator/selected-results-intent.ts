import { types } from 'node:util'
import { canonicalJsonData } from '@i-harness/core-session'
import { readSelectedResultsOperation, type ForkOperationV2 } from '../selected-results-fork-contract.ts'
import { bootstrapFields } from './bootstrap-header.ts'

export type SelectedResultsCaptureRequestV1 = Readonly<{
  invocation: ForkOperationV2['invocation']
  core: ForkOperationV2['prepared']['core']
  requestIntent: ForkOperationV2['prepared']['requestIntent']
}>
export type SelectedResultsReservationV1 = Readonly<{
  version: 1
  kind: 'semantic-bootstrap-selected-results-capture'
  request: SelectedResultsCaptureRequestV1
}>
const invalid = (): never => { throw new TypeError('Invalid selected results capture data') }

export function captureSelectedResultsCaptureRequest(input: unknown): SelectedResultsCaptureRequestV1 {
  bootstrapFields(input, ['invocation', 'core', 'requestIntent'])
  const operation = readSelectedResultsOperation({version:2,kind:'session-fork-operation',
    prepared:{version:2,kind:'session-fork-prepared',core:input.core,requestIntent:input.requestIntent,requestDigest:input.invocation?.requestDigest},
    invocation:input.invocation})
  return Object.freeze({invocation:operation.invocation,core:operation.prepared.core,requestIntent:operation.prepared.requestIntent})
}
function captureReservation(input: unknown): SelectedResultsReservationV1 {
  bootstrapFields(input, ['version','kind','request'])
  if (input.version !== 1 || input.kind !== 'semantic-bootstrap-selected-results-capture') invalid()
  return Object.freeze({version:1,kind:'semantic-bootstrap-selected-results-capture',request:captureSelectedResultsCaptureRequest(input.request)})
}
export function encodeSelectedResultsReservation(input: unknown): Uint8Array {
  const bytes = Buffer.from(canonicalJsonData(captureReservation(input)) + '\n', 'utf8')
  if (bytes.length > 262144) invalid()
  return bytes
}
export function parseSelectedResultsReservation(bytes: Uint8Array): SelectedResultsReservationV1 {
  if (types.isProxy(bytes) || !(bytes instanceof Uint8Array) || bytes.length > 262144) invalid()
  const input: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
  const result = captureReservation(input)
  if (!Buffer.from(encodeSelectedResultsReservation(result)).equals(Buffer.from(bytes))) invalid()
  return result
}
