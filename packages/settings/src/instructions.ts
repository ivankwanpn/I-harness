import { basename, isAbsolute, join } from "node:path"
import { resolveHarnessHome } from "@i-harness/harness-home"

/** Saved structural policy. Absent globals select the native pair; [] selects none. */
export interface SettingsInstructions { enabled: boolean; maxBytes: number; globalSources?: string[] }
export interface InstructionPolicy { readonly enabled: boolean; readonly maxBytes: number; readonly globalSources: readonly string[] }

/** Inspect descriptors before reading user-supplied mutation values. */
export function assertInstructionData(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return
  if (seen.has(value)) throw new Error("instructions: cyclic data")
  seen.add(value)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) throw new Error("instructions: expected plain data")
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") throw new Error("instructions: symbol keys are not allowed")
    const descriptor = descriptors[key]!
    if (!("value" in descriptor)) throw new Error("instructions: accessors are not allowed")
    assertInstructionData(descriptor.value, seen)
  }
  seen.delete(value)
}

export function validInstructionSources(value: unknown): value is string[] {
  try { assertInstructionData(value) } catch { return false }
  return Array.isArray(value) && value.length <= 256 && Array.from(value).every((path) =>
    typeof path === "string" && !path.includes("\0") && isAbsolute(path)
      && (basename(path) === "AGENTS.md" || basename(path) === "CLAUDE.md"),
  ) && new Set(value).size === value.length
}

export function validateInstructions(value: unknown): asserts value is SettingsInstructions {
  assertInstructionData(value)
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("instructions: expected object")
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !["enabled", "maxBytes", "globalSources"].includes(key))) throw new Error("instructions: unknown field")
  if (typeof raw.enabled !== "boolean") throw new Error("instructions.enabled: expected boolean")
  if (!Number.isSafeInteger(raw.maxBytes) || (raw.maxBytes as number) < 0) throw new Error("instructions.maxBytes: expected nonnegative safe integer")
  if (Object.hasOwn(raw, "globalSources") && !validInstructionSources(raw.globalSources)) throw new Error("instructions.globalSources: expected at most 256 unique absolute candidate paths")
}

/** Pure normalization; corrupt explicit globals deny discovery instead of widening it. */
export function normalizeInstructions(value: unknown): SettingsInstructions {
  let raw: Record<string, unknown> = {}
  try {
    assertInstructionData(value)
    if (value !== null && typeof value === "object" && !Array.isArray(value)) raw = value as Record<string, unknown>
  } catch { return { enabled: true, maxBytes: 24000, globalSources: [] } }
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    maxBytes: Number.isSafeInteger(raw.maxBytes) && (raw.maxBytes as number) >= 0 ? raw.maxBytes as number : 24000,
    ...(Object.hasOwn(raw, "globalSources") ? { globalSources: validInstructionSources(raw.globalSources) ? [...raw.globalSources] : [] } : {}),
  }
}

/** Resolve paths only from the host-selected config home, without probing files. */
export function resolveInstructionPolicy(saved: SettingsInstructions, configDir?: string): InstructionPolicy {
  const home = resolveHarnessHome(configDir)
  if (home.length === 0 || !isAbsolute(home)) throw new Error("instructions: config home must be absolute")
  const policy = normalizeInstructions(saved)
  return Object.freeze({ ...policy, globalSources: Object.freeze(policy.globalSources ?? [join(home, "AGENTS.md"), join(home, "CLAUDE.md")]) })
}
