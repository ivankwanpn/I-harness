import { createHash } from "node:crypto"
/** Hashes are ephemeral evidence; consumers persist a chain/count, never units. */
export function projectionFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex")
}
