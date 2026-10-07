import { createHash } from "node:crypto"
import { isAbsolute, normalize, relative, sep } from "node:path"
import type { AuthorityState, CompiledSandboxPolicy, ExecutionOwner, SandboxMode } from "@i-harness/sandbox"

function fail(detail: string): never { throw new Error(`Execution authority: ${detail}`) }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("malformed state or owner")
  return value as Record<string, unknown>
}
function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) fail(`invalid ${name}`)
  return value
}
function mode(value: unknown): SandboxMode {
  if (value !== "read-only" && value !== "workspace-write" && value !== "danger-full-access") fail("invalid mode")
  return value
}
function owner(value: unknown): Readonly<ExecutionOwner> {
  const input = record(value)
  return Object.freeze({ sessionId: identifier(input.sessionId, "session ID"), ...(input.parentSessionId === undefined ? {} : { parentSessionId: identifier(input.parentSessionId, "parent session ID") }) })
}
// Lexical compiler spellings only: this does not resolve symlinks, junctions or reparse races.
function path(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) fail("invalid absolute path")
  const normalized = normalize(value)
  const withoutTrailing = normalized.endsWith(sep) && normalize(normalized + "..") !== normalized ? normalized.slice(0, -1) : normalized
  return process.platform === "win32" ? withoutTrailing.toLowerCase() : withoutTrailing
}
function paths(value: unknown): readonly string[] {
  if (!Array.isArray(value)) fail("invalid path list")
  return Object.freeze([...new Set(Array.from(value, path))].sort())
}
function contains(root: string, child: string): boolean {
  const tail = relative(root, child)
  return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`))
}
type Content = Omit<CompiledSandboxPolicy, "fingerprint">
function content(value: unknown): Content {
  const input = record(value)
  const kind = input.authorityKind
  if (kind !== "bound" && kind !== "unbound") fail("invalid authority kind")
  if (input.readable !== "caller") fail("invalid readable policy")
  const result: Content = {
    mode: mode(input.mode), owner: owner(input.owner), authorityRevision: identifier(input.authorityRevision, "revision"),
    authorityKind: kind, primaryRoot: path(input.primaryRoot), readable: "caller", authorityRoots: paths(input.authorityRoots),
    writeRoots: paths(input.writeRoots), referenceRoots: paths(input.referenceRoots),
  }
  if (result.mode !== "workspace-write" && result.writeRoots.length) fail("mode cannot grant write roots")
  if (!result.authorityRoots.includes(result.primaryRoot)) fail("missing primary authority root")
  if (result.mode === "workspace-write" && JSON.stringify(result.writeRoots) !== JSON.stringify(result.authorityRoots)) fail("write roots differ from authority roots")
  if (kind === "unbound" && result.authorityRoots.length !== 1) fail("invalid unbound roots")
  for (const writable of result.writeRoots) for (const reference of result.referenceRoots) {
    // First phase cannot implement nested read-only carveouts; refuse either overlap direction.
    if (contains(writable, reference) || contains(reference, writable)) fail("writable/reference overlap is unsupported")
  }
  return result
}
function fingerprint(value: Content): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function compileExecutionPolicy(input: { mode: SandboxMode; owner: ExecutionOwner; authority: AuthorityState }): CompiledSandboxPolicy {
  const request = record(input)
  const selectedMode = mode(request.mode)
  const selectedOwner = owner(request.owner)
  const authority = record(request.authority)
  const revision = identifier(authority.revision, "revision")
  if (authority.kind === "revoked" || authority.kind === "unavailable") fail(`authority ${authority.kind}`)
  let primaryRoot: string
  let roots: readonly string[]
  let references: readonly string[]
  if (authority.kind === "unbound") {
    primaryRoot = path(authority.workspaceRoot); roots = [primaryRoot]; references = paths(authority.references ?? [])
  } else if (authority.kind === "bound") {
    primaryRoot = path(authority.primaryRoot); roots = paths(authority.roots); references = paths(authority.references)
  } else fail("malformed authority state")
  const canonical = content({
    mode: selectedMode, owner: selectedOwner, authorityRevision: revision, authorityKind: authority.kind,
    primaryRoot, readable: "caller", authorityRoots: [primaryRoot, ...roots],
    writeRoots: selectedMode === "workspace-write" ? [primaryRoot, ...roots] : [], referenceRoots: references,
  })
  return Object.freeze({ ...canonical, fingerprint: fingerprint(canonical) })
}

export function assertExecutionAuthority(prepared: CompiledSandboxPolicy, current: CompiledSandboxPolicy): void {
  const before = content(prepared)
  const after = content(current)
  const beforeDigest = fingerprint(before)
  const afterDigest = fingerprint(after)
  if (prepared.fingerprint !== beforeDigest || current.fingerprint !== afterDigest || beforeDigest !== afterDigest) fail("snapshot changed or fingerprint invalid")
}
