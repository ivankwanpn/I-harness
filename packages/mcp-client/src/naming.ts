import { createHash } from "node:crypto"

// dsh contract + codex sanitize/hash: `mcp__<serverName>__<rawName>` (64 chars,
// `[A-Za-z0-9_-]`), SHA-256 12-hex hash appended when normalization/truncation
// changes the name so distinct identities never collapse.
export const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

/**
 * THE ONE mounted-server-name grammar (Task 8 ruling, quoted by
 * plugin-registry's `mcpServerKey`): `[A-Za-z0-9_.:-]`, 1..64 characters,
 * colon being the namespace separator. `validateMcpConfig` (types.ts) and
 * `assertServerName` below MUST test this same pattern — two copies is exactly
 * how the producer/consumer contract drifted (D-MCP-1: `mcpServerKey` emits
 * `plugin:<id>:<server>` and both validators refused it, so every plugin MCP
 * server was skipped before a client ever started). plugin-registry cannot
 * import this constant (mount.ts's structural return: that package does not
 * depend on this one), so its composer mirrors the same grammar and cap — and
 * BOUNDS its two parts so the 64-char cap is guaranteed, not hoped for.
 * 64 is the house cap: `validateNameList` (types.ts) uses the same bound.
 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

export function assertServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`mcp-client: serverName must match ${SERVER_NAME_PATTERN.source} (got "${name}")`)
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
