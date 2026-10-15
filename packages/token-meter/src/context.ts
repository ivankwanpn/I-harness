import { stringifyJsonData } from "@i-harness/core-session"
import { createHash } from "node:crypto"
import type { LLMMessage } from "@i-harness/core-session"
import { estimateContent } from "./estimate.ts"

import { normalizeInputUsage, type InputUsage } from "./calibration-usage.ts"
import { createProjectionCalibration } from "./checkpoint.ts"
import type { ContextUsageCheckpoint } from "@i-harness/core-session"
export { normalizeInputUsage } from "./calibration-usage.ts"

interface ContextRequest { messages: LLMMessage[]; systemPrompt: string; tools: unknown[]; model?: string; reasoningEffort?: string }
type ContextEstimate = { tokens: number; source: "provider" | "estimate" }
const fingerprint = (value: unknown): string => createHash("sha256").update(stringifyJsonData(value)!).digest("hex")
const shape = (request: ContextRequest): string => fingerprint({ system: request.systemPrompt, tools: request.tools, model: request.model, reasoningEffort: request.reasoningEffort })

/** One completed-request anchor, containing hashes only. No prompt body cache.
 * A prefix edit invalidates it permanently; a later identical body cannot revive
 * measurements from before a rewind, reset, prune, binding or catalog change. */
function createLegacyContextMeter() {
  let anchor: { shape: string; messages: string[]; tokens: number; revision: number } | undefined
  return {
    invalidate(): void { anchor = undefined },
    record(request: ContextRequest, usage: InputUsage, revision = 0): void {
      anchor = undefined
      const normalized = normalizeInputUsage(usage)
      if (!normalized || normalized.totalInputTokens === 0 || request.messages.length > 10000) return
      anchor = { shape: shape(request), messages: request.messages.map(fingerprint), tokens: normalized.totalInputTokens, revision }
    },
    estimate(request: ContextRequest, overhead = 0, revision = 0): ContextEstimate {
      if (!Number.isSafeInteger(overhead) || overhead < 0) throw new Error("context overhead must be a non-negative integer")
      if (anchor && (anchor.revision !== revision || anchor.shape !== shape(request) || request.messages.length < anchor.messages.length
        || anchor.messages.some((value, index) => fingerprint(request.messages[index]) !== value))) anchor = undefined
      return anchor ? { tokens: anchor.tokens + estimateContent(request.messages.slice(anchor.messages.length)), source: "provider" }
        : { tokens: estimateContent(request.messages) + overhead, source: "estimate" }
    },
  }
}

/** Legacy no-argument API remains compatible. Owned mode calibrates actual
 * protocol projection facts and persists only a scalar prefix checkpoint. */
export function createContextMeter(): ReturnType<typeof createLegacyContextMeter>
export function createContextMeter(options: { ownerSessionId: string; restored?: ContextUsageCheckpoint }): ReturnType<typeof createProjectionCalibration>
export function createContextMeter(options?: { ownerSessionId: string; restored?: ContextUsageCheckpoint }) {
  return options ? createProjectionCalibration(options.ownerSessionId, options.restored) : createLegacyContextMeter()
}
