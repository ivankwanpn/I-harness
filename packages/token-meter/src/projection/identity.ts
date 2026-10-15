import { createHash } from "node:crypto"
import { encodeSdkCommandData } from "./sdk-data.ts"
import type { SemanticInputIdentityV2 } from "./types.ts"

type Domain = "binding" | "shape" | "unit" | "input" | "prefix-seed" | "prefix-link"
/** Domains and versions are part of the bytes, never metadata relabeling. */
export function semanticProjectionDigest(domain: Domain, value: unknown): string {
  return encodedProjectionDigest(domain, encodeSdkCommandData(value))
}
export function encodedProjectionDigest(domain: Domain | "http-json-body" | "sdk-command-estimate", encoded: string): string {
  return createHash("sha256").update(`i-harness:projection:v2:${domain}\0`, "utf8").update(encoded, "utf8").digest("hex")
}
export function semanticInputIdentity(binding: unknown, shape: unknown, input: unknown, units: readonly { semanticId?: string }[]): SemanticInputIdentityV2 {
  const bindingId = semanticProjectionDigest("binding", { adapterRevision: "effective-input-v2", binding })
  const shapeId = semanticProjectionDigest("shape", { bindingId, nativeReplayPolicy: "adapter-projected-native-v1", shape })
  const semanticId = semanticProjectionDigest("input", { bindingId, shapeId, units: units.map(unit => unit.semanticId), input })
  return { version: 2, schema: "projected-input-v2", pricingVersion: "projected-pricing-v2", bindingId, shapeId, semanticId }
}
