// @i-harness/tui — M49 Task 10: recursive secret redaction (spec §7.3).
//
// Key set (exact, matched case-insensitively): apiKey, api_key, token,
// authorization, password. Recursive over objects/arrays; the RESULT is a
// fresh structure — the original payload is never mutated. Redaction lives at
// the UI boundary: the presentation module (format.ts) and the raw viewer
// (views/block-viewer.ts) always pass the payload through HERE before any
// render — the raw payload is never rendered un-redacted.

/** The known secret key set (spec §7.3) — exact, case-insensitive. */
export const SECRET_KEYS = ["apiKey", "api_key", "token", "authorization", "password"] as const

/** The redaction placeholder. */
export const REDACTED = "***"

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase()
  for (const name of SECRET_KEYS) if (name.toLowerCase() === k) return true
  return false
}

/** Recursively redact `value`: every member whose KEY matches the secret set
 * becomes `***` (scalars and whole subtrees alike — a secret field's value is
 * never inspected, kept, or rendered). Arrays map element-wise; primitives
 * pass through. The output is a deep clone — the input is never mutated. */
export function redactToolPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactToolPayload(item))
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactToolPayload(sub)
    }
    return out
  }
  return value
}
