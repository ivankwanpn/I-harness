import { existsSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { delimiter, isAbsolute, join } from "node:path"
import type { PreparedToolIdentity } from "@i-harness/core-tools"
import type { AgentShellDialect, ShellToolDeps } from "../types.ts"
import { environmentValue } from "../discovery/environment.ts"

export function createVersionIdentity(deps: Pick<ShellToolDeps, "cwd">) {
  // Remember only a fully literal native --version query. General commands can
  // load profiles, config, hooks, scripts or interpreters whose complete binding
  // is opaque at this layer. Advisory getArgv is never permission evidence.
  function versionIdentity(args: { command: string }, executable: string, dialect: AgentShellDialect): PreparedToolIdentity | undefined {
    if (dialect !== "posix" || ["BASH_ENV", "ENV", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].some((key) => environmentValue(process.env, key)) || Object.keys(process.env).some((key) => key.startsWith("BASH_FUNC_"))) return undefined
    const match = /^(?:"([A-Za-z0-9_ ./:\\-]+)"|'([A-Za-z0-9_ ./:\\-]+)'|([A-Za-z0-9_./:\\-]+)) --version$/.exec(args.command)
    const target = match?.[1] ?? match?.[2] ?? match?.[3]
    if (!target || !isAbsolute(target)) return undefined
    // Other native programs can load config/plugins even for --version. Only
    // the host's known Node binary has a supported complete version-query shape.
    try { if (realpathSync(target) !== realpathSync(process.execPath)) return undefined } catch { return undefined }
    const resolved = isAbsolute(executable) ? executable : (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, executable)).find(existsSync)
    if (!resolved || !isAbsolute(resolved)) return undefined
    const environmentDigest = createHash("sha256").update(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex")
    return { binding: JSON.stringify({ version: 1, cwd: deps.cwd ?? process.cwd(), shell: resolved, dialect, environmentDigest }), executablePaths: [resolved, target], command: { text: args.command, dialect } }
  }
  return versionIdentity
}

export type VersionIdentity = ReturnType<typeof createVersionIdentity>
