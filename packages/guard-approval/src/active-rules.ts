import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync, type BigIntStats } from "node:fs"
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path"
import type { PreparedApprovalInput } from "@i-harness/core-tools"

export interface ApprovalEvidence {
  name: string
  workspaceId: string
  policyRevision: string
  argsDigest: string
  bindingDigest: string
  executableDigest: string
  /** Complete JSON, supplied only when display is safe. */
  arguments: string
  commandArgv?: string[]
}
type ApprovalRuleScope = { kind: "workspace" } | { kind: "session"; sessionId: string }
export interface ApprovalRule { id: string; evidence: ApprovalEvidence; scope: ApprovalRuleScope; createdAt: number; expiresAt: number }
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

// The shipped Electron image is 246 MB. 512 MiB leaves growth room while
// bounding synchronous validation I/O; memory stays at a single 1 MiB buffer.
// Two full reads below also detect writes hidden by Windows deferred timestamps.
const executableFingerprintLimit = 512 * 1024 * 1024
const executableReadSize = 1024 * 1024

function sameExecutableFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

/** Capture both alias ancestry and canonical ancestry so a stable system alias
 * works, but switching a link, directory or opened target cannot create evidence. */
function executableAncestry(path: string): { path: string; identity: string }[] {
  const absolute = resolve(path), root = parse(absolute).root
  let current = root
  return [root, ...absolute.slice(root.length).split(/[\\/]/).filter(Boolean)].map((part, index) => {
    if (index > 0) current = join(current, part)
    const stat = lstatSync(current, { bigint: true })
    if (!(stat.isDirectory() || stat.isFile() || stat.isSymbolicLink()) || stat.ino === 0n) throw new Error("executable path identity is unavailable")
    return { path: current, identity: `${stat.dev}:${stat.ino}:${stat.mode}${stat.isSymbolicLink() ? `:${stat.ctimeNs}:${realpathSync(current)}` : ""}` }
  })
}

function fingerprintExecutable(path: string): { path: string; digest: string } {
  if (!isAbsolute(path)) throw new Error("executable path is unresolved")
  const real = realpathSync(path)
  const ancestry = [...executableAncestry(path), ...executableAncestry(real)]
  const before = lstatSync(real, { bigint: true })
  if (!before.isFile() || before.ino === 0n) throw new Error("executable path is not a stable regular file")
  if (before.size > BigInt(executableFingerprintLimit)) throw new Error("executable identity exceeds fingerprint limit")
  const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let contentDigest: string
  try {
    if (!sameExecutableFile(before, fstatSync(fd, { bigint: true }))) throw new Error("executable changed or was replaced before fingerprinting")
    const buffer = Buffer.alloc(executableReadSize)
    const size = Number(before.size)
    const readDigest = () => {
      const hash = createHash("sha256")
      let position = 0
      while (position < size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position)
        if (count === 0) throw new Error("executable changed while fingerprinting")
        if (position === 0 && !(count >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a
          || count >= 4 && buffer[0] === 0x7f && buffer.subarray(1, 4).toString() === "ELF")) throw new Error("scripts or unsupported executable formats require one-time approval")
        hash.update(buffer.subarray(0, count)); position += count
      }
      if (size === 0) throw new Error("scripts or unsupported executable formats require one-time approval")
      if (readSync(fd, buffer, 0, 1, position) !== 0 || !sameExecutableFile(before, fstatSync(fd, { bigint: true }))) throw new Error("executable changed while fingerprinting")
      return hash.digest("hex")
    }
    contentDigest = readDigest()
    if (readDigest() !== contentDigest) throw new Error("executable content changed while fingerprinting")
  } finally { closeSync(fd) }
  // Windows can defer last-write metadata until the final open handle closes.
  // Check the named file after close as well as the held handle before close.
  if (!sameExecutableFile(before, lstatSync(real, { bigint: true })) || relative(realpathSync(path), real) !== ""
    || canonicalApprovalArguments(ancestry) !== canonicalApprovalArguments([...executableAncestry(path), ...executableAncestry(real)])) throw new Error("executable or its path changed while fingerprinting")
  return { path: real, digest: contentDigest }
}

export function canonicalApprovalArguments(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value)
    if (result === undefined || typeof value === "number" && !Number.isFinite(value)) throw new Error("arguments are not JSON")
    return result
  }
  if (Array.isArray(value)) return `[${value.map(canonicalApprovalArguments).join(",")}]`
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("opaque argument object")
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalApprovalArguments((value as Record<string, unknown>)[key])}`).join(",")}}`
}

/** A literal single native invocation, with no script/wrapper/expansion. */
function parseRememberableCommand(command: string, dialect: "posix" | "powershell" | "cmd"): string[] | undefined {
  if (dialect !== "posix" || command.length > 4000 || /[\r\n;&|<>$`{}()!#*?\[\]]/.test(command)) return undefined
  const argv: string[] = []
  const token = /\s*(?:"([A-Za-z0-9_ ./:\\=-]+)"|'([A-Za-z0-9_ ./:\\=-]+)'|([A-Za-z0-9_./:\\=-]+))/gy
  let end = 0
  while (end < command.length) {
    token.lastIndex = end
    const match = token.exec(command)
    if (!match) { if (command.slice(end).trim() === "") break; return undefined }
    // POSIX unquoted backslashes and doubled backslashes inside double quotes
    // are escapes, so a literal path claim would not name the launched file.
    if (match[3]?.includes("\\") || match[1]?.includes("\\\\")) return undefined
    argv.push(match[1] ?? match[2] ?? match[3]!); end = token.lastIndex
    if (end < command.length && !/\s/.test(command[end]!)) return undefined
  }
  const executable = argv[0]
  if (!executable || !isAbsolute(executable) || /\.(?:cmd|bat|ps1|sh|py|js|mjs|ts)$/i.test(executable)
    || /^(?:bash|sh|zsh|fish|cmd|pwsh|powershell|node|python\d*|ruby|perl|env|sudo|doas|xargs)(?:\.exe)?$/i.test(basename(executable)) && !(argv.length === 2 && argv[1] === "--version")) return undefined
  return argv
}

export function prepareApprovalEvidence(input: PreparedApprovalInput & { workspaceId: string; policyRevision: string }): { evidence?: ApprovalEvidence; reason?: string } {
  try {
    if (!input.workspaceId || !input.policyRevision) throw new Error("current policy identity is unavailable")
    if (input.validateBinding?.() === false) throw new Error("tool binding was replaced or revoked")
    const identity = input.tool.approvalIdentity?.(input.call.args)
    if (!identity?.binding) throw new Error("tool has no complete prepared binding identity")
    const argumentsJson = canonicalApprovalArguments(input.call.args)
    if (argumentsJson.length > 4000 || /"[^" ]*(?:token|secret|password|authorization|api.?key)[^" ]*"\s*:/i.test(argumentsJson)) throw new Error("complete arguments cannot be displayed safely; approve this operation once")
    const commandArgv = identity.command ? parseRememberableCommand(identity.command.text, identity.command.dialect) : undefined
    if (identity.command && !commandArgv) throw new Error("command structure or executable identity is ambiguous; use one-time approval")
    const paths = [...identity.executablePaths ?? []]
    if (commandArgv && !paths.includes(commandArgv[0]!)) paths.push(commandArgv[0]!)
    const executables = paths.map(fingerprintExecutable)
    return { evidence: { name: input.call.name, workspaceId: input.workspaceId, policyRevision: input.policyRevision,
      argsDigest: digest(argumentsJson), arguments: argumentsJson,
      bindingDigest: digest(canonicalApprovalArguments({ binding: identity.binding, generation: input.bindingGeneration ?? 1, execute: input.tool.execute.toString(), schema: input.tool.inputSchema })),
      executableDigest: digest(canonicalApprovalArguments(executables)), ...(commandArgv ? { commandArgv } : {}) } }
  } catch (error) { return { reason: error instanceof Error ? error.message : String(error) } }
}

function validEvidence(value: unknown): value is ApprovalEvidence {
  if (!value || typeof value !== "object") return false
  const row = value as ApprovalEvidence
  return [row.name, row.workspaceId, row.policyRevision, row.arguments].every((field) => typeof field === "string" && field.length > 0)
    && [row.argsDigest, row.bindingDigest, row.executableDigest].every((field) => typeof field === "string" && /^[a-f0-9]{64}$/.test(field))
    && row.arguments.length <= 4000 && digest(row.arguments) === row.argsDigest
    && (row.commandArgv === undefined || Array.isArray(row.commandArgv) && row.commandArgv.every((item) => typeof item === "string"))
}
function validScope(value: unknown): value is ApprovalRuleScope {
  if (!value || typeof value !== "object") return false
  const scope = value as ApprovalRuleScope
  return scope.kind === "workspace" || scope.kind === "session" && typeof scope.sessionId === "string" && scope.sessionId.length > 0
}

export function createApprovalRuleStore(path: string, clock: () => number = Date.now) {
  function list(): ApprovalRule[] {
    let document: unknown
    try { document = JSON.parse(readFileSync(path, "utf8")) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
    const rows = document as { version?: unknown; rules?: unknown }
    if (rows?.version !== 1 || !Array.isArray(rows.rules) || rows.rules.length > 1000) throw new Error("invalid approval rule store")
    if (!rows.rules.every((rule: ApprovalRule) => rule && typeof rule.id === "string" && validEvidence(rule.evidence) && validScope(rule.scope) && Number.isFinite(rule.createdAt) && Number.isFinite(rule.expiresAt) && rule.expiresAt > rule.createdAt)) throw new Error("invalid approval rule")
    return rows.rules as ApprovalRule[]
  }
  function save(rules: ApprovalRule[]): void {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, rules }), { encoding: "utf8", mode: 0o600 })
    renameSync(temporary, path)
  }
  return {
    list,
    add(evidence: ApprovalEvidence, scope: ApprovalRuleScope, expiresAt: number): ApprovalRule {
      if (!validEvidence(evidence) || !validScope(scope) || !Number.isFinite(expiresAt) || expiresAt <= clock() || expiresAt > clock() + 365 * 86400000) throw new Error("invalid approval rule scope, evidence or expiry")
      const rules = list(); if (rules.length >= 1000) throw new Error("approval rule limit reached")
      const rule: ApprovalRule = { id: randomUUID(), evidence: structuredClone(evidence), scope: structuredClone(scope), createdAt: clock(), expiresAt }
      save([...rules, rule]); return structuredClone(rule)
    },
    revoke(id: string): void { save(list().filter((rule) => rule.id !== id)) },
    removeSession(sessionId: string): void { save(list().filter((rule) => rule.scope.kind !== "session" || rule.scope.sessionId !== sessionId)) },
    matches(evidence: ApprovalEvidence, sessionId?: string): boolean {
      try { return list().some((rule) => rule.expiresAt > clock() && (rule.scope.kind === "workspace" || rule.scope.sessionId === sessionId)
        && canonicalApprovalArguments(rule.evidence) === canonicalApprovalArguments(evidence)) } catch { return false }
    },
  }
}
