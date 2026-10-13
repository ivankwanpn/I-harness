import { createHash } from "node:crypto"
import { accessSync, constants, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { resolveHarnessHome } from "@i-harness/harness-home"
import { diagnosticsFor } from "@i-harness/diagnostics"
import type { HookHandlerSpec } from "./types.ts"
import { HookTrustError } from "./types.ts"
import { resolveClaudeShell, sha256ClaudePluginTree, sha256ClaudePluginTreeSync } from "./claude.ts"
import { resolveWindowsHookExecutable } from "./windows-process.ts"

// W6 T6: ONE module-scope handle for this file's one report. The phase is
// `config`: the trust store IS configuration (which handlers the user has
// approved), which is why this file takes `config` while the registry's own
// failure report takes `mount`. With nothing installed the handle delegates
// to console.warn verbatim (one argument) — unset mode is the pre-migration
// bytes.
const d = diagnosticsFor("config")

/** sha256 of a file (the trust primitive). */
export async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

/** The executed artifact a spec's trust hash is computed over. */
export function trustScriptPath(spec: HookHandlerSpec, configDir: string): string {
  const raw = spec.trust.script
  return isAbsolute(raw) ? raw : resolve(configDir, raw)
}

interface HookCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

function sameFile(left: string, right: string): boolean {
  return left === right
}

function regularFile(path: string): string {
  const file = realpathSync.native(path)
  if (!statSync(file).isFile()) throw new Error("trust artifact or executable is not a regular file")
  return file
}

function nativeExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") return resolveWindowsHookExecutable(command, cwd, env)
  if (isAbsolute(command) || command.includes("/")) return resolve(cwd, command)
  for (const directory of (env.PATH ?? "").split(":")) {
    const candidate = resolve(cwd, directory, command)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* next executable PATH entry */ }
  }
  throw new Error("executable was not found on PATH")
}

function hostScriptRuntime(executable: string, env: NodeJS.ProcessEnv): boolean {
  if (sameFile(executable, regularFile(process.execPath))) return true
  for (const shell of ["bash", "sh"] as const) {
    try { if (sameFile(executable, regularFile(resolveClaudeShell(shell, env)))) return true }
    catch { /* An unavailable optional host shell grants no script execution. */ }
  }
  return false
}

/** Pin the native argv whose executable content the file grant actually covers. */
export function trustedHookCommand(spec: HookHandlerSpec, configDir: string, options: HookCommandOptions = {}): { cmd: string; args: string[]; artifact: string } {
  const artifact = regularFile(trustScriptPath(spec, configDir))
  const cwd = resolve(spec.command.cwd ?? options.cwd ?? dirname(trustScriptPath(spec, configDir)))
  const env = options.env ?? process.env
  try {
    const executable = regularFile(nativeExecutable(spec.command.cmd, cwd, env)), args = spec.command.args ?? []
    if (sameFile(executable, artifact) && args.length === 0) return { cmd: executable, args: [], artifact }
    // Only fixed host file-launch forms preserve a script-content grant. Extra
    // arguments can be inline code, preloads or another artifact; put them in
    // a reviewed wrapper instead of borrowing this file's approval.
    if (args.length === 1 && hostScriptRuntime(executable, env) && sameFile(regularFile(resolve(cwd, args[0]!)), artifact)) {
      return { cmd: executable, args: [artifact], artifact }
    }
  } catch (error) {
    throw new HookTrustError(spec.id, spec.trust.sha256, "command.cmd/args are not bound to the trusted artifact: " + (error instanceof Error ? error.message : String(error)))
  }
  throw new HookTrustError(spec.id, spec.trust.sha256, "command.cmd/args are not bound to the trusted artifact")
}

/** Verify both the executable binding and the unchanged approved content. */
export async function verifyHandlerTrust(spec: HookHandlerSpec, configDir: string, options: HookCommandOptions = {}): Promise<void> {
  const actual = spec.claude === undefined
    ? await sha256File(trustedHookCommand(spec, configDir, options).artifact)
    : await sha256ClaudePluginTree(spec.claude.pluginRoot)
  if (actual !== spec.trust.sha256) throw new HookTrustError(spec.id, spec.trust.sha256, actual)
}

/** The same binding/content check at the last synchronous dispatch boundary. */
export function verifyHandlerTrustSync(spec: HookHandlerSpec, configDir: string, options: HookCommandOptions = {}): void {
  const actual = spec.claude === undefined
    ? createHash("sha256").update(readFileSync(trustedHookCommand(spec, configDir, options).artifact)).digest("hex")
    : sha256ClaudePluginTreeSync(spec.claude.pluginRoot)
  if (actual !== spec.trust.sha256) throw new HookTrustError(spec.id, spec.trust.sha256, actual)
}

/** One user-approved artifact. The KEY is the hash: approval is of CONTENT. */
export interface HookApproval {
  sha256: string
  script: string
  handlerId: string
  approvedAt: string
}

/** The user-layer grant set. */
export interface HookTrustStore {
  isApproved(sha256: string): boolean
  approve(entry: { sha256: string; script: string; handlerId: string }, now?: Date): void
  revoke(sha256: string): void
  list(): HookApproval[]
}

/** The user-layer approval file: `<configDir|$IH_CONFIG_DIR|~/.i-harness>/hook-trust.json`.
 * Resolved through `@i-harness/harness-home` — the one sanctioned home resolver
 * (`8c7d670a`), so this cannot drift from the other three chains that used to
 * disagree. */
export function resolveHookTrustPath(configDir?: string): string {
  return join(configDir ?? resolveHarnessHome(), "hook-trust.json")
}

/**
 * Every failure mode here lands on the SAME answer — an empty grant set — and
 * that is the point: an unreadable, absent or unshaped file approves nothing, so
 * a damaged store cannot accidentally widen what may run. Only `approve` and
 * `revoke` write, so a read never materialises the file.
 */
function loadApprovals(path: string): Map<string, HookApproval> {
  const out = new Map<string, HookApproval>()
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return out // absent → nothing is approved, and no file is created by reading
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    d.warn(`[hooks] trust store ${path} is not valid JSON; treating as NO approvals`)
    return out
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out
  const list = (raw as { approvals?: unknown }).approvals
  if (!Array.isArray(list)) return out
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue
    const e = entry as Record<string, unknown>
    // The hash is the KEY, and it is the only field that decides anything —
    // the rest is audit trail. A row without a usable hash approves nothing.
    if (typeof e.sha256 !== "string" || e.sha256 === "") continue
    out.set(e.sha256, {
      sha256: e.sha256,
      script: typeof e.script === "string" ? e.script : "",
      handlerId: typeof e.handlerId === "string" ? e.handlerId : "",
      approvedAt: typeof e.approvedAt === "string" ? e.approvedAt : "",
    })
  }
  return out
}

/**
 * The user-layer grant set: which artifact HASHES the user has approved.
 *
 * Keyed on the hash rather than on a handler id or a path, because approval is
 * of CONTENT — an id is chosen by the declaring layer and a path can be
 * repointed, so neither is an object worth trusting. A handler whose script is
 * byte-identical to an approved one is the approved one.
 *
 * This is deliberately NOT what `verifyHandlerTrust` does: that compares the
 * artifact against the hash the CONFIG declares, so a config naming its own
 * script satisfies it. **This store is the layer that decides whether the
 * declaration was ever granted.** Both checks run; they catch different lies.
 */
export function createHookTrustStore(path: string): HookTrustStore {
  const approvals = loadApprovals(path)
  const persist = (): void => {
    const body = { version: 1, approvals: [...approvals.values()] }
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8")
  }
  return {
    isApproved: (sha256: string): boolean => approvals.has(sha256),
    approve(entry, now = new Date()): void {
      approvals.set(entry.sha256, {
        sha256: entry.sha256,
        script: entry.script,
        handlerId: entry.handlerId,
        approvedAt: now.toISOString(),
      })
      persist()
    },
    revoke(sha256: string): void {
      if (approvals.delete(sha256)) persist() // absent → no write, no throw
    },
    list: (): HookApproval[] => [...approvals.values()],
  }
}
