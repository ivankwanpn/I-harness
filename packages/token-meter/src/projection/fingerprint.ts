import { stringifyJsonData } from "@i-harness/core-session"
import { createHash } from "node:crypto"
/** Hashes are ephemeral evidence; consumers persist a chain/count, never units. */
export function projectionFingerprint(value: unknown): string {
  return createHash("sha256").update(stringifyJsonData(value) ?? "null").digest("hex")
}
