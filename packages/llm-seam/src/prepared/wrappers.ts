import type { LLMRequest, LLMStreamEvent, ModelClient } from "../index.ts"
import type { PreparedModelRequest, PreparedStreamControl } from "./types.ts"
import type { PreparedRequestMeasurement } from "@i-harness/token-meter"
import { prepareModelRequest } from "./fallback.ts"
/** Copy data without cloning abort signals, callbacks, transport functions or
 * the original affinity-scope identity. Buffer copies remain SDK bytes. */
export function snapshotModelData<T>(value: T, exclude: readonly string[] = []): T {
  type Work = { value: unknown; put: (value: unknown) => void; exclude?: readonly string[] } | { source: object; key: string; put: (value: unknown) => void } | { leave: object }
  let result: unknown
  const seen = new WeakMap<object, unknown>(), work: Work[] = [{ value, exclude, put: item => { result = item } }]
  while (work.length) {
    const task = work.pop()!
    if ("leave" in task) { seen.delete(task.leave); continue }
    const item = "source" in task ? (task.source as Record<string, unknown>)[task.key] : task.value
    if ("key" in task && task.key === "requestScope") { task.put(item); continue }
    if (item instanceof Date) { task.put(new Date(item.getTime())); continue }
    if (item instanceof Uint8Array) { task.put(Buffer.from(item)); continue }
    if (!item || typeof item !== "object" || item instanceof AbortSignal) { task.put(item); continue }
    const previous = seen.get(item)
    if (previous) { task.put(previous); continue }
    const array = Array.isArray(item), copy: unknown[] | Record<string, unknown> = array ? new Array(item.length) : {}
    seen.set(item, copy); task.put(copy)
    work.push({ leave: item })
    const keys = array ? Array.from({ length: item.length }, (_, index) => String(index)).filter(key => key in item)
      : Object.keys(item).filter(key => !("exclude" in task && task.exclude?.includes(key)))
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!
      work.push({ source: item, key, put: child => Object.defineProperty(copy, key, { value: child, writable: true, enumerable: true, configurable: true }) })
    }
  }
  return result as T
}
const composedCallbacks = new WeakMap<Function, readonly Function[]>()
function compose<T extends unknown[]>(a: ((...args: T) => void) | undefined, b: ((...args: T) => void) | undefined): ((...args: T) => void) | undefined {
  if (!a || a === b) return b ?? a
  if (!b) return a
  const callbacks = [...new Set([...(composedCallbacks.get(a) ?? [a]), ...(composedCallbacks.get(b) ?? [b])])] as ((...args: T) => void)[]
  const result = (...args: T) => { for (const callback of callbacks) callback(...args) }
  composedCallbacks.set(result, callbacks)
  return result
}
export function preparedControls(request: PreparedStreamControl, control?: PreparedStreamControl): PreparedStreamControl {
  return {
    validateBeforeTransport: compose(request.validateBeforeTransport, control?.validateBeforeTransport),
    confirmExecution: compose(request.confirmExecution, control?.confirmExecution),
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
    get executionIdentity() { return client.executionIdentity },
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
