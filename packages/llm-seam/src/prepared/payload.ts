import { stringifyJsonData } from "@i-harness/core-session"
import type { PreparedRequestMeasurement, ProjectedInputFacts } from "@i-harness/token-meter"
import type { LLMRequest, LLMStreamEvent } from "../index.ts"
import type { PreparedModelRequest, PreparedStreamControl } from "./types.ts"
import { freezePreparedFacts, preparedControls, snapshotModelData, validateOutputCap } from "./wrappers.ts"
/** The adapter retains the private payload; derivatives replace generation
 * fields only. HTTP execution sends the very string whose bytes were measured. */
export function createPreparedPayload<T>(options: {
  body: T
  request: LLMRequest
  input: ProjectedInputFacts
  packet: Omit<PreparedRequestMeasurement["packet"], "bodyBytes" | "sdkCommandBytesEstimate">
  output: (body: T, request: LLMRequest) => PreparedRequestMeasurement["output"]
  cap: (body: T, cap: number | undefined) => T
  execute: (body: T, serialized: string, control: PreparedStreamControl) => AsyncIterable<LLMStreamEvent>
}): PreparedModelRequest {
  const original = snapshotModelData(options.body)
  const input = freezePreparedFacts(options.input)
  function derive(body: T, request = options.request): PreparedModelRequest {
    const serialized = stringifyJsonData(body)!
    const output = options.output(body, request)
    validateOutputCap(output.effectiveCap, output.minimumCap)
    const measurement = freezePreparedFacts({
      projectionId: input.inputFingerprint, input, output,
      packet: {
        ...options.packet, ...(options.packet.sizeKind === "http-json-body"
          ? { bodyBytes: Buffer.byteLength(serialized) }
          : { sdkCommandBytesEstimate: Buffer.byteLength(serialized) })
      },
    })
    return Object.freeze({
      measurement,
      withOutputCap(cap: number | undefined) {
        validateOutputCap(cap, output.minimumCap)
        return derive(options.cap(snapshotModelData(original), cap), { ...options.request, maxOutputTokens: cap })
      },
      stream(control?: PreparedStreamControl) {
        const actual = preparedControls(options.request, control)
        actual.signal?.throwIfAborted()
        return options.execute(snapshotModelData(body), serialized, actual)
      },
    })
  }
  return derive(original)
}
