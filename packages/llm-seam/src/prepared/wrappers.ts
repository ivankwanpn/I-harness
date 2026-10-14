import type { LLMRequest, LLMStreamEvent, ModelClient } from "../index.ts"
import type { PreparedModelRequest, PreparedStreamControl } from "./types.ts"
import type { PreparedRequestMeasurement } from "@i-harness/token-meter"
import { prepareModelRequest } from "./fallback.ts"
/** Copy data without cloning abort signals, callbacks, transport functions or
 * the original affinity-scope identity. Buffer copies remain SDK bytes. */
export function snapshotModelData<T>(value: T, exclude: readonly string[] = []): T {
  if (value instanceof Date)
    return new Date(value.getTime()) as T
  if (value instanceof Uint8Array)
    return Buffer.from(value) as T
  if (Array.isArray(value))
    return value.map(item => snapshotModelData(item)) as T
  if (value && typeof value === "object") {
    if (value instanceof AbortSignal)
      return value
    return Object.fromEntries(Object.keys(value).filter(key => !exclude.includes(key)).map(key => {
      const item = (value as Record<string, unknown>)[key]
      return [key, key === "requestScope" ? item : snapshotModelData(item)]
    })) as T
  }
  return value
}
export function preparedControls(request: PreparedStreamControl, control?: PreparedStreamControl): PreparedStreamControl {
  return {
    validateBeforeTransport: control?.validateBeforeTransport ?? request.validateBeforeTransport,
    signal: control?.signal ?? request.signal,
    onStreamActivity: control?.onStreamActivity ?? request.onStreamActivity,
    onTerminalResponse: control?.onTerminalResponse ?? request.onTerminalResponse,
  }
}
export function wrapPreparedRequest(prepared: PreparedModelRequest, wrap: (stream: (control?: PreparedStreamControl) => AsyncIterable<LLMStreamEvent>, control: PreparedStreamControl | undefined, measurement: PreparedRequestMeasurement) => AsyncIterable<LLMStreamEvent>): PreparedModelRequest {
  return Object.freeze({
    measurement: prepared.measurement,
    withOutputCap: (cap: number | undefined) => wrapPreparedRequest(prepared.withOutputCap(cap), wrap),
    stream: (control?: PreparedStreamControl) => wrap(next => prepared.stream(next), control, prepared.measurement),
  })
}
/** Reuse an owner's existing execution wrapper against a frozen send capability.
 * Derivatives re-enter the owner; no inner raw stream can escape. */
export function withPreparedRequests(client: ModelClient, wrap: (inner: ModelClient, measurement: PreparedRequestMeasurement) => ModelClient): ModelClient {
  return preparedModelClient(async (request) => {
    const captured = snapshotModelData(request)
    const prepared = await prepareModelRequest(client, captured)
    captured.signal?.throwIfAborted()
    return wrapPreparedRequest(prepared, (stream, control, measurement) => wrap({ stream: executionRequest => stream(preparedControls(captured, executionRequest)) }, measurement)
      .stream({ ...captured, ...preparedControls(captured, control) }))
  })
}
export function mapModelRequest(client: ModelClient, map: (request: LLMRequest) => LLMRequest): ModelClient {
  return {
    stream: request => client.stream(map(request)),
    prepare: request => prepareModelRequest(client, map(request)),
  }
}
/** Deep readonly facts only; transport Buffers remain private in closures. */
export function freezePreparedFacts<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value))
      freezePreparedFacts(item)
    Object.freeze(value)
  }
  return value
}
export function invalidPreparedRequest(message: string, code = "INVALID_ARGUMENT"): Error {
  return Object.assign(new Error(message), { code, legacyErrorEvent: true, modelFailure: { code, message, reason: code === "MODEL_BINDING_MISMATCH" ? "unknown" : "output-limit" } })
}
export function preparedModelClient(prepare: NonNullable<ModelClient["prepare"]>): ModelClient {
  return {
    prepare,
    async *stream(request) {
      let prepared: PreparedModelRequest
      try {
        prepared = await prepare(request)
      }
      catch (error) {
        if (request.signal?.aborted || !(error instanceof Error) || !(error as Error & {
          legacyErrorEvent?: boolean
        }).legacyErrorEvent)
          throw error
        yield { type: "error", error }
        return
      }
      yield* prepared.stream()
    },
  }
}
export function validateOutputCap(cap: number | undefined, minimum = 1): void {
  if (!Number.isSafeInteger(minimum) || minimum < 1 || cap !== undefined && (!Number.isSafeInteger(cap) || cap < minimum))
    throw invalidPreparedRequest("Prepared output cap is below the adapter minimum or is not a positive safe integer")
}
