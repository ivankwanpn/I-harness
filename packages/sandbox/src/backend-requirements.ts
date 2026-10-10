import type { BackendDecision, BackendProbe, BackendRequirements } from "./execution.ts"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assurance(value: unknown): value is BackendProbe["assurance"] {
  return value === "verified" || value === "experimental" || value === "unverified"
}

function validProbe(value: unknown): value is BackendProbe {
  if (!record(value) || typeof value.id !== "string"
    || (value.availability !== "available" && value.availability !== "unavailable")
    || !assurance(value.assurance) || (value.detail !== undefined && typeof value.detail !== "string")
    || !record(value.features)) return false
  const features = value.features
  if (features.referenceProtection !== undefined && typeof features.referenceProtection !== "boolean") return false
  return ["writeIsolation", "readIsolation", "denyPaths", "pipes", "pty", "retainedTree"]
    .every(key => typeof features[key] === "boolean")
}

function validRequirements(value: unknown): value is BackendRequirements {
  return record(value)
    && typeof value.writeIsolation === "boolean"
    && typeof value.readIsolation === "boolean"
    && typeof value.denyPaths === "boolean"
    && (value.referenceProtection === undefined || typeof value.referenceProtection === "boolean")
    && (value.transport === "pipe" || value.transport === "pty")
    && (value.lifetime === "complete-tree" || value.lifetime === "retain-tree")
    && assurance(value.minimumAssurance)
}

const assuranceRank = { unverified: 0, experimental: 1, verified: 2 } as const

/** Compare one probe with explicit requirements; never select or fall back to a backend. */
export function checkBackendRequirements(probe: BackendProbe, requirements: BackendRequirements): BackendDecision {
  if (!validProbe(probe) || !validRequirements(requirements)) {
    return { ok: false, missing: ["invalid-contract"] }
  }
  const missing = new Set<string>()
  if (probe.availability !== "available") missing.add("availability")
  if (requirements.writeIsolation && !probe.features.writeIsolation) missing.add("write-isolation")
  if (requirements.readIsolation && !probe.features.readIsolation) missing.add("read-isolation")
  if (requirements.denyPaths && !probe.features.denyPaths) missing.add("deny-paths")
  if (requirements.referenceProtection && !(probe.features.referenceProtection ?? probe.features.denyPaths)) missing.add("reference-protection")
  if (requirements.transport === "pipe" && !probe.features.pipes) missing.add("pipe")
  if (requirements.transport === "pty" && !probe.features.pty) missing.add("pty")
  if (requirements.lifetime === "retain-tree" && !probe.features.retainedTree) missing.add("retained-tree")
  if (assuranceRank[probe.assurance] < assuranceRank[requirements.minimumAssurance]) missing.add("assurance")
  return missing.size === 0 ? { ok: true } : { ok: false, missing: [...missing] }
}
