import { preparedExecution, type ExecutionConfirmation, type PreparedExecutionContext } from "./execution.ts"
import { stringifyJsonData } from "@i-harness/core-session"
import { encodeSdkCommandData, encodedProjectionDigest, type PayloadIdentityV2, type PreparedRequestMeasurement, type ProjectedInputFacts } from "@i-harness/token-meter"
import type { LLMRequest, LLMStreamEvent } from "../index.ts"
import type { PreparedModelRequest, PreparedStreamControl } from "./types.ts"
import { freezePreparedFacts, preparedControls, snapshotModelData, validateOutputCap } from "./wrappers.ts"
import { createPreparedValidation, readPreparedValidation, sanitizePreparedValidation, type FinalValidator } from './validation.ts'
import { finalValidationError } from './rejection.ts'
import { normalizePreparedTextOutput, readPreparedTextOutput, type PreparedTextOutput } from './text-output.ts'
import { NO_GENERATION_RETRY } from './generation.ts'
import { assertOwnedPreparedTerminal, isOwnedPreparedTerminal, preparedExecutionSource } from './owned-terminal.ts'

type OwnedExecutionConfirmation = Readonly<Pick<ExecutionConfirmation, 'version' | 'sendId' | 'semanticId' | 'payloadId' | 'payloadKind'>>
const ownedConfirmations = new WeakMap<ExecutionConfirmation, { source: PreparedModelRequest; facts: OwnedExecutionConfirmation }>()
/** Package-private cooperation reader. Terminal completion is not Agent source
 * acceptance or a native reuse permit. No payload or transport capability escapes. */
export function readOwnedExecutionConfirmation(confirmation: ExecutionConfirmation, expectedPrepared: PreparedModelRequest): OwnedExecutionConfirmation | undefined {
  const evidence = ownedConfirmations.get(confirmation)
  return evidence && isOwnedPreparedTerminal(expectedPrepared) && preparedExecutionSource(expectedPrepared) === evidence.source ? evidence.facts : undefined
}
/** The adapter retains the private payload; derivatives replace generation
 * fields only. HTTP execution sends the very string whose bytes were measured. */
export interface PreparedPayloadOptions<T> {
  body: T
  request: LLMRequest
  kind?: "http-json-body" | "sdk-command-estimate"
  validate?: FinalValidator<T>
  textOutput?: (actualBody: T) => PreparedTextOutput
  describe: (body: T, request: LLMRequest) => { input: ProjectedInputFacts; packet: Omit<PreparedRequestMeasurement["packet"], "bodyBytes" | "sdkCommandBytesEstimate"> }
  output: (body: T, request: LLMRequest) => PreparedRequestMeasurement["output"]
  cap: (body: T, cap: number | undefined) => T
  execute: (body: T, serialized: string, control: PreparedStreamControl, execution: PreparedExecutionContext) => AsyncIterable<LLMStreamEvent>
}
export function createPreparedPayload<T>(options: PreparedPayloadOptions<T>): PreparedModelRequest {
  return preparePayload(options, false)
}
/** Package-private fixed HTTP/SDK terminal composition, never a public custom
 * execute registration API. The facade exposes only createPreparedPayload. */
export function createOwnedPreparedPayload<T>(options: PreparedPayloadOptions<T>): PreparedModelRequest {
  return preparePayload(options, true)
}
function preparePayload<T>(options: PreparedPayloadOptions<T>, owned: boolean): PreparedModelRequest {
  // Lower HTTP values once: description, derivatives and send all observe the
  // same JSON semantics even when callers supplied Date/toJSON/accessors.
  const sdk = options.kind === "sdk-command-estimate"
  const originalSerialized = sdk ? undefined : stringifyJsonData(options.body)!
  const original: T = sdk ? snapshotModelData(options.body) : JSON.parse(originalSerialized!)
  function derive(body: T, request = options.request): PreparedModelRequest {
    const serialized = sdk ? encodeSdkCommandData(body) : body === original ? originalSerialized! : stringifyJsonData(body)!
    const actualBody: T = sdk ? body : JSON.parse(serialized)
    const bytes = Buffer.byteLength(serialized)
    const result = options.validate?.(actualBody, sdk ? { kind: 'sdk-command-estimate', sdkCommandBytesEstimate: bytes } : { kind: 'http-json-body', bodyBytes: bytes })
    const validated = result && sanitizePreparedValidation(result.report)
    if (options.validate && (!result || !validated || !['accepted', 'rejected'].includes(result.kind)
      || result.kind === 'accepted' && validated.status === 'invalid'
      || result.kind === 'rejected' && validated.status !== 'invalid')) throw new TypeError('Invalid final validation result')
    if (result?.kind === 'rejected') throw finalValidationError(result.reason, validated!)
    const { input, packet } = options.describe(actualBody, request)
    const output = options.output(actualBody, request)
    validateOutputCap(output.effectiveCap, output.minimumCap)
    const payloadIdentity: PayloadIdentityV2 = { version: 2, kind: sdk ? "sdk-command-estimate" : "http-json-body", id: encodedProjectionDigest(sdk ? "sdk-command-estimate" : "http-json-body", serialized) }
    const measurement = freezePreparedFacts({
      projectionId: input.inputFingerprint, input, output,
      payloadIdentity,
      packet: {
        ...packet, ...(!sdk
          ? { bodyBytes: bytes }
          : { sdkCommandBytesEstimate: bytes })
      },
    })
    const validation = validated ?? readPreparedValidation({ measurement })
    const prepared: PreparedModelRequest = Object.freeze({
      retryPolicy: NO_GENERATION_RETRY,
      measurement, validation,
      textOutput: options.textOutput ? normalizePreparedTextOutput(options.textOutput(actualBody)) : readPreparedTextOutput({}),
      withOutputCap(cap: number | undefined) {
        if (options.validate && cap !== undefined && (!Number.isSafeInteger(cap) || cap < output.minimumCap))
          throw finalValidationError('output-limit', createPreparedValidation({ ...validation, status: 'invalid', issues: [{ rule: 'output-range', site: 'generation' }], omittedIssueCount: 0 }))
        validateOutputCap(cap, output.minimumCap)
        return derive(options.cap(snapshotModelData(original), cap), { ...options.request, maxOutputTokens: cap })
      },
      async *stream(control?: PreparedStreamControl) {
        const actual = preparedControls(options.request, control)
        if (actual.generation) assertOwnedPreparedTerminal(prepared)
        actual.signal?.throwIfAborted()
        let confirmation: ExecutionConfirmation | undefined, issued = false, failed = false
        const execution = preparedExecution(measurement, owned ? { ...actual,
          confirmExecution(value) { confirmation = value; actual.confirmExecution?.(value) },
          onTransportIssue() { issued = true; actual.onTransportIssue?.() },
        } : actual, validation)
        try {
          for await (const event of options.execute(snapshotModelData(actualBody), serialized, actual, execution)) {
            if (event.type === 'error') failed = true
            if (event.type === 'end' || event.type === 'error') await execution.settle(event.type === 'end' ? 'completed' : (event.error as Error & { code?: string }).code === 'TRANSPORT' ? 'unknown' : 'failed')
            if (owned && confirmation) {
              if (failed) ownedConfirmations.delete(confirmation)
              else if (event.type === 'end' && issued && !actual.signal?.aborted) {
                const { version, sendId, semanticId, payloadId, payloadKind } = confirmation
                ownedConfirmations.set(confirmation, { source: prepared, facts: Object.freeze({ version, sendId, semanticId, payloadId, payloadKind }) })
              }
            }
            yield event
          }
        } catch (error) {
          if (confirmation) ownedConfirmations.delete(confirmation)
          throw error
        } finally {
          // Fixed waiting/retry composition closes after observing end, and
          // waiting aborts its private controller during cleanup. Successful
          // terminal end survives that cleanup; any observed failure revokes it.
          try { await execution.settle('unknown') }
          catch (error) {
            if (confirmation) ownedConfirmations.delete(confirmation)
            throw error
          }
        }
      },
    })
    return prepared
  }
  return derive(original)
}
