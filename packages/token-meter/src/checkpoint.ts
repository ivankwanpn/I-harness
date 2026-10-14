import { validContextCheckpoint, type ContextBindingMetadata, type ContextUsageCheckpoint } from "@i-harness/core-session"
import type { ProjectedInputFacts } from "./projection/types.ts"
import { projectionFingerprint } from "./projection/fingerprint.ts"
import { normalizeInputUsage } from "./calibration-usage.ts"

export function projectedTokens(input: ProjectedInputFacts): number { return Object.values(input.components).reduce((sum, component) => sum + component.heuristicTokens, 0) }
export function prefixChain(input: ProjectedInputFacts, count = input.units.length): string {
  let hash = projectionFingerprint("context-prefix-v1")
  for (const unit of input.units.slice(0, count)) hash = projectionFingerprint([hash, unit.fingerprint])
  return hash
}
export function createProjectionCalibration(ownerSessionId: string, restored?: ContextUsageCheckpoint) {
  let anchor: ContextUsageCheckpoint | undefined = validContextCheckpoint(restored) && restored.ownerSessionId === ownerSessionId && restored.identityCoverage === "complete" ? Object.freeze({ ...restored }) : undefined
  let live = false
  return {
    invalidate() { anchor = undefined; live = false },
    record(input: ProjectedInputFacts, metadata: ContextBindingMetadata | undefined, usage: Parameters<typeof normalizeInputUsage>[0] & { outputTokens?: number }, revision: number): ContextUsageCheckpoint | undefined {
      anchor = undefined
      const normalized = normalizeInputUsage(usage)
      if (!normalized || !normalized.totalInputTokens || input.coverage === "incomplete") return undefined
      anchor = Object.freeze({ version: 1, ownerSessionId, bindingFingerprint: input.bindingFingerprint, shapeFingerprint: input.shapeFingerprint,
        identityCoverage: metadata?.identityCoverage ?? "partial", ...(metadata?.bindingConfigFingerprint ? { bindingConfigFingerprint: metadata.bindingConfigFingerprint } : {}),
        inputPrefixFingerprint: prefixChain(input), inputUnitCount: input.units.length, heuristicPrefixTokens: projectedTokens(input), reportedInputTokens: normalized.totalInputTokens,
        ...(Number.isSafeInteger(usage.outputTokens) && usage.outputTokens! >= 0 ? { reportedOutputTokens: usage.outputTokens } : {}), projectionRevision: revision })
      live = true
      return anchor
    },
    estimate(input: ProjectedInputFacts, metadata: ContextBindingMetadata | undefined, revision: number) {
      if (anchor && (anchor.ownerSessionId !== ownerSessionId || anchor.projectionRevision !== revision || anchor.bindingFingerprint !== input.bindingFingerprint
        || anchor.shapeFingerprint !== input.shapeFingerprint || input.units.length < anchor.inputUnitCount || prefixChain(input, anchor.inputUnitCount) !== anchor.inputPrefixFingerprint
        || anchor.bindingConfigFingerprint !== metadata?.bindingConfigFingerprint || (!live && (metadata?.identityCoverage !== "complete" || !metadata.bindingConfigFingerprint)))) anchor = undefined
      const heuristic = projectedTokens(input)
      if (!anchor) return { tokens: heuristic, calibrated: false }
      // Total reported output can include hidden generation which is not
      // replayed. Without a provider breakdown it is billing evidence only.
      // Price every actually projected reasoning/call/text/suffix unit once;
      // never attach the whole generation counter to its first assistant unit.
      const suffix = Math.max(0, heuristic - anchor.heuristicPrefixTokens)
      return { tokens: anchor.reportedInputTokens + suffix, calibrated: true }
    },
  }
}
