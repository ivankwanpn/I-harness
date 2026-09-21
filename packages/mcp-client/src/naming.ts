import { createHash } from "node:crypto"

// dsh contract + codex sanitize/hash: `mcp__<serverName>__<rawName>` (64 chars,
// `[A-Za-z0-9_-]`), SHA-256 12-hex hash appended when normalization/truncation
// changes the name so distinct identities never collapse.
export const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
/** The grammar every provider accepts for a tool name (and this repo's public
 * tool-name surface). Distinct from the SERVER_NAME_PATTERN below: a name can
 * be a valid SERVER name (`:`, `.`) and an invalid TOOL name. */
const PROVIDER_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * THE ONE mounted-server-name grammar (Task 8 ruling, quoted by
 * plugin-registry's `mcpServerKey`): `[A-Za-z0-9_.:-]`, 1..64 characters,
 * colon being the namespace separator. `validateMcpConfig` (types.ts) and
 * `assertServerName` below MUST test this same pattern — two copies is exactly
 * how the producer/consumer contract drifted (D-MCP-1: `mcpServerKey` emits
 * `plugin:<id>:<server>` and both validators refused it, so every plugin MCP
 * server was skipped before a client ever started). plugin-registry's
 * PRODUCTION code does not import from this package (mount.ts's structural
 * return: no dependency in that direction), so its composer mirrors the same
 * grammar and cap — and BOUNDS its two parts so the 64-char cap is
 * guaranteed, not hoped for. That mirroring is pinned by that package's seam
 * test, which does depend on this package (a devDependency, test tree only).
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

/**
 * A provider-safe tool name for a name COMPOSED from a server name — used by
 * resources.ts's `list_mcp_resources__<serverName>` family, the one tool-name
 * surface `bridge.ts`'s `publicToolName` does not cover.
 *
 * The contract is deliberately conservative in one direction: a candidate that
 * ALREADY satisfies the provider grammar is returned byte-identical (every
 * server name this repo has ever mounted: `files`, `mx`, `probe`), so nothing
 * observable changes for them. Anything else — and D-MCP-1's plugin keys
 * (`plugin:<id>:<server>`, colons by construction) are exactly that — is
 * sanitized to `_` and given a 12-hex SHA-256 suffix over the FULL candidate,
 * so two distinct server names can never collapse onto one tool name.
 *
 * It exists because the server-name grammar (`[A-Za-z0-9_.:-]`) and the tool
 * name grammar are NOT the same grammar: a mount that validates perfectly can
 * still hand the model a name no backend accepts, and one such name fails the
 * whole request — outside the assembly's per-server containment.
 */
export function fitPublicName(candidate: string): string {
  if (PROVIDER_TOOL_NAME_PATTERN.test(candidate)) return candidate
  const normalized = candidate.replace(INVALID_NAME_CHARS, "_")
  const hash = createHash("sha256").update(candidate).digest("hex").slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}
