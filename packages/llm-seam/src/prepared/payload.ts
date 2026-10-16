import { preparedExecution, type PreparedExecutionContext } from "./execution.ts"
import { stringifyJsonData } from "@i-harness/core-session"
import { encodeSdkCommandData, encodedProjectionDigest, type PayloadIdentityV2, type PreparedRequestMeasurement, type ProjectedInputFacts } from "@i-harness/token-meter"
import type { LLMRequest, LLMStreamEvent } from "../index.ts"
import type { PreparedModelRequest, PreparedStreamControl } from "./types.ts"
import { freezePreparedFacts, preparedControls, snapshotModelData, validateOutputCap } from "./wrappers.ts"
import { createPreparedValidation, readPreparedValidation, sanitizePreparedValidation, type FinalValidator } from './validation.ts'
import { finalValidationError } from './rejection.ts'
/** The adapter retains the private payload; derivatives replace generation
 * fields only. HTTP execution sends the very string whose bytes were measured. */
export function createPreparedPayload<T>(options: {
  body: T
  request: LLMRequest
  kind?: "http-json-body" | "sdk-command-estimate"
  validate?: FinalValidator<T>
  describe: (body: T, request: LLMRequest) => { input: ProjectedInputFacts; packet: Omit<PreparedRequestMeasurement["packet"], "bodyBytes" | "sdkCommandBytesEstimate"> }
  output: (body: T, request: LLMRequest) => PreparedRequestMeasurement["output"]
  cap: (body: T, cap: number | undefined) => T
  execute: (body: T, serialized: string, control: PreparedStreamControl, execution: PreparedExecutionContext) => AsyncIterable<LLMStreamEvent>
}): PreparedModelRequest {
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
    return Object.freeze({
      measurement, validation,
      withOutputCap(cap: number | undefined) {
        if (options.validate && cap !== undefined && (!Number.isSafeInteger(cap) || cap < output.minimumCap))
          throw finalValidationError('output-limit', createPreparedValidation({ ...validation, status: 'invalid', issues: [{ rule: 'output-range', site: 'generation' }], omittedIssueCount: 0 }))
        validateOutputCap(cap, output.minimumCap)
        return derive(options.cap(snapshotModelData(original), cap), { ...options.request, maxOutputTokens: cap })
      },
      stream(control?: PreparedStreamControl) {
        const actual = preparedControls(options.request, control)
        actual.signal?.throwIfAborted()
        return options.execute(snapshotModelData(actualBody), serialized, actual, preparedExecution(measurement, actual, validation))
      },
    })
  }
  return derive(original)
}
