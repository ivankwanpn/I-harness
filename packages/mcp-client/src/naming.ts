import { createHash } from "node:crypto"

// dsh contract + codex sanitize/hash: `mcp__<serverName>__<rawName>` (64 chars,
// `[A-Za-z0-9_-]`), SHA-256 12-hex hash appended when normalization/truncation
// changes the name so distinct identities never collapse.
export const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function assertServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`mcp-client: serverName must match ^[A-Za-z0-9_-]{1,32}$ (got "${name}")`)
  }
}

export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, "_")
  // `__` inside either segment makes the `mcp__<server>__<raw>` join ambiguous
  // to parse back (a + "b__c" and "a__b" + c would both parse as
  // mcp__a__b__c), so force the hash branch and keep distinct identities apart.
  const ambiguous = serverName.includes("__") || rawName.includes("__")
  if (!ambiguous && normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}
