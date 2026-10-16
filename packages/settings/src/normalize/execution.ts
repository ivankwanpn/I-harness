import type { ModelWaitSettings, SettingsCodeMode, SettingsWslExecution } from "../schema/types.ts"
import { isRecord, booleanOf, oneOf } from "./primitives.ts"

export function normalizeWslExecution(raw: unknown): SettingsWslExecution {
  const value = isRecord(raw) ? raw : {}
  const distribution = typeof value.distribution === "string" ? value.distribution.trim() : ""
  return {
    distribution: distribution && distribution.length <= 256 && !/[\u0000-\u001f\u007f]/.test(distribution) ? distribution : "Ubuntu",
    networkAccess: booleanOf(value.networkAccess, false),
    workspaceDependencies: booleanOf(value.workspaceDependencies, true),
  }
}

export function normalizeCodeMode(raw: unknown): SettingsCodeMode {
  const value = isRecord(raw) ? raw : {}
  const result: SettingsCodeMode = { mode: oneOf(value.mode, ["off", "mixed", "only"] as const, "off") }
  const bounds = { memoryLimitMb: [8, 256], cpuTimeMs: [10, 10_000], maxActiveCells: [1, 16], maxPendingCalls: [1, 256], maxSourceBytes: [1, 1024 * 1024], maxResultBytes: [1, 16 * 1024 * 1024], maxStoreBytes: [1, 4 * 1024 * 1024], defaultYieldTimeMs: [0, 60_000], defaultOutputTokens: [0, 4096] } as const
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    const input = value[key]
    if (typeof input === "number" && Number.isFinite(input)) {
      const [min, max] = bounds[key]
      result[key] = Math.min(max, Math.max(min, Math.floor(input)))
    }
  }
  return result
}

export function validModelWaitSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && (value === 0 || value >= 30 && value <= 3600)
}

export function normalizeModelWait(value: unknown): ModelWaitSettings {
  const data = value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
  return {
    firstResponseSeconds: validModelWaitSeconds(data.firstResponseSeconds) ? data.firstResponseSeconds : 300,
    progressSeconds: validModelWaitSeconds(data.progressSeconds) ? data.progressSeconds : 300,
  }
}
