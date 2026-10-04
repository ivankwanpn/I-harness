import { createHash } from "node:crypto"
import type { LLMMessage } from "@i-harness/core-session"
import { estimateContent } from "./estimate.ts"

interface InputUsage {
  inputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  inputTokenSemantics?: "includes-cache" | "excludes-cache"
}

/** Raw counters remain unchanged. This derived total is only for input sizing. */
export function normalizeInputUsage(usage: InputUsage): { totalInputTokens: number; cacheReadRatio?: number } | undefined {
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  if (!valid(usage.inputTokens) || !["includes-cache", "excludes-cache"].includes(usage.inputTokenSemantics ?? "")) return
  for (const value of [usage.cacheReadTokens, usage.cacheCreationTokens]) if (value !== undefined && !valid(value)) return
  const totalInputTokens = usage.inputTokenSemantics === "includes-cache" ? usage.inputTokens
    : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
  if (!valid(totalInputTokens) || (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0) > totalInputTokens) return
  return { totalInputTokens, ...(usage.cacheReadTokens === undefined || totalInputTokens === 0 ? {} : { cacheReadRatio: usage.cacheReadTokens / totalInputTokens }) }
}

interface ContextRequest { messages: LLMMessage[]; systemPrompt: string; tools: unknown[]; model?: string; reasoningEffort?: string }
type ContextEstimate = { tokens: number; source: "provider" | "estimate" }
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const shape = (request: ContextRequest): string => fingerprint({ system: request.systemPrompt, tools: request.tools, model: request.model, reasoningEffort: request.reasoningEffort })

/** One completed-request anchor, containing hashes only. No prompt body cache.
 * A prefix edit invalidates it permanently; a later identical body cannot revive
 * measurements from before a rewind, reset, prune, binding or catalog change. */
export function createContextMeter() {
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
