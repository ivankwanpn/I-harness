import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { createHookTrustStore, loadHooksConfig, resolveHookTrustPath } from "@i-harness/hooks"
import { assertResourcePath, contentRevision, mutateResourceFile, readResourceFile, validateResourceName } from "./resource-files.ts"
import { authoredHookPath, type LocalResourceSource } from "./effective-local-inputs.ts"
import { acquireSessionLock } from "@i-harness/fs-lock"

export interface HookConfigWrite { source: LocalResourceSource; body: string; expectedRevision: string | null }
export interface HookScriptWrite extends HookConfigWrite { name: string }
export type HookAuthoringRequest =
  | { kind: "desktop/hooks/read-config"; workspaceId: string; source: LocalResourceSource }
  | ({ kind: "desktop/hooks/write-config"; workspaceId: string } & HookConfigWrite)
  | { kind: "desktop/hooks/read-script"; workspaceId: string; source: LocalResourceSource; name: string }
  | ({ kind: "desktop/hooks/write-script"; workspaceId: string } & HookScriptWrite)
export type HookAuthoringRequestHandler = (request: HookAuthoringRequest) => Promise<unknown>
type Bindings = Record<string, Record<string, string>>
const bindingPath = (configDir: string) => join(configDir, "hook-authoring-grants.json")
export function isAuthoredHookPath(configDir: string, path: string) {
  const canonical = resolve(path)
  return canonical === resolve(join(configDir, "hooks", "authored", "hooks.json")) || /[\\/]\.i-harness[\\/]hooks[\\/]hooks\.json$/.test(canonical)
}
function readBindings(configDir: string): Bindings {
  assertResourcePath(configDir, bindingPath(configDir))
  try {
    const body: unknown = JSON.parse(readFileSync(bindingPath(configDir), "utf8"))
    if (!body || typeof body !== "object" || Array.isArray(body)) return {}
    const data = body as { version?: unknown; bindings?: Bindings }
    return data.version === 1 && data.bindings && typeof data.bindings === "object" && !Array.isArray(data.bindings) ? data.bindings : {}
  } catch { return {} }
}
function persistBindings(configDir: string, bindings: Bindings) {
  assertResourcePath(configDir, bindingPath(configDir))
  mkdirSync(configDir, { recursive: true })
  const temporary = join(configDir, `.hook-bindings-${randomUUID()}.tmp`)
  try { writeFileSync(temporary, JSON.stringify({ version: 1, bindings }), { flag: "wx" }); renameSync(temporary, bindingPath(configDir)) }
  finally { rmSync(temporary, { force: true }) }
}
function fingerprint(configPath: string): string {
  const root = dirname(configPath), file = readResourceFile(root, configPath)
  if (!file) throw new Error("Hook config missing")
  const config = JSON.parse(file.body) as { version: number; handlers: { trust: { script: string } }[] }
  if (config.version !== 1 || !Array.isArray(config.handlers)) throw new Error("Invalid hook config")
  const scripts = config.handlers.map(handler => {
    const path = resolve(root, handler.trust.script), script = readResourceFile(root, path)
    if (!script) throw new Error("Hook script missing")
    return [path, script.revision]
  })
  return contentRevision(JSON.stringify([file.revision, scripts]))
}
/** Runtime must pass this per config to createHookRegistry AND refreshTrust.
 * The existing script hash grants remain authoritative; authored configs additionally
 * require the full config and every referenced script to match the reviewed bytes. */
export function createAuthoredHookApprovals(configDir: string, configPath: string) {
  const store = createHookTrustStore(resolveHookTrustPath(configDir))
  return {
    ...store,
    isApproved(sha256: string) {
      if (!createHookTrustStore(resolveHookTrustPath(configDir)).isApproved(sha256)) return false
      if (!isAuthoredHookPath(configDir, configPath)) return true
      try { return readBindings(configDir)[resolve(configPath)]?.[sha256] === fingerprint(configPath) } catch { return false }
    },
  }
}
/** Called while holding the hook trust lock, after identity was re-read. */
export function bindAuthoredHookApproval(configDir: string, configPath: string, sha256: string) {
  if (!isAuthoredHookPath(configDir, configPath)) return
  const bindings = readBindings(configDir)
  ;(bindings[resolve(configPath)] ??= {})[sha256] = fingerprint(configPath)
  persistBindings(configDir, bindings)
}

export function createHookAuthoring(workspace: string, configDir: string, refresh: () => Promise<void>) {
  const rootFor = (source: LocalResourceSource) => {
    if (source !== "global" && source !== "workspace") throw new Error("Hook source must be workspace or global")
    return source === "global" ? configDir : workspace
  }
  const pathFor = (source: LocalResourceSource) => { rootFor(source); return authoredHookPath(workspace, configDir, source) }
  const scriptPath = (source: LocalResourceSource, name: string) => { validateResourceName(name); return join(dirname(pathFor(source)), "scripts", `${name}.cjs`) }
  async function invalidate(source: LocalResourceSource) {
    mkdirSync(configDir, { recursive: true })
    const lock = await acquireSessionLock({ lockPath: `${resolveHookTrustPath(configDir)}.lock`, deadlineMs: 10000 })
    try {
      const path = pathFor(source), bindings = readBindings(configDir)
      delete bindings[resolve(path)]; persistBindings(configDir, bindings)
    } finally { await lock.release() }
    try { await refresh() } catch { throw new Error("Hook content saved and grant invalidated, but live refresh failed. Reload and retry refresh.") }
  }
  return {
    readConfig(source: LocalResourceSource) { return readResourceFile(rootFor(source), pathFor(source)) ?? { body: '{\n  "version": 1,\n  "handlers": []\n}\n', revision: null } },
    readScript(source: LocalResourceSource, name: string) { return readResourceFile(rootFor(source), scriptPath(source, name)) ?? { body: "", revision: null } },
    async writeConfig(command: HookConfigWrite) {
      const root = rootFor(command.source), path = pathFor(command.source)
      const result = await mutateResourceFile(root, path, command.expectedRevision, command.body, async body => {
        // Validate using the runtime parser. A temporary config shares the same
        // base directory and has no home trust bypass; validation never executes.
        const temporary = join(dirname(path), `.validate-${randomUUID()}.json`)
        const { mkdir, writeFile, rm } = await import("node:fs/promises")
        await mkdir(dirname(path), { recursive: true })
        try {
          await writeFile(temporary, body, { flag: "wx" })
          const loaded = await loadHooksConfig(temporary, dirname(path), { isApproved: () => false })
          if (loaded.length > 100 || new Set(loaded.map(row => row.spec.id)).size !== loaded.length) throw new Error("Hook config requires at most 100 unique handler IDs")
          for (const row of loaded) {
            readResourceFile(dirname(path), resolve(dirname(path), row.spec.trust.script))
            if (!row.valid && !row.unapproved) throw new Error(row.trustError)
          }
        } finally { await rm(temporary, { force: true }) }
      })
      if (result.kind === "saved") await invalidate(command.source)
      return result
    },
    async writeScript(command: HookScriptWrite) {
      const result = await mutateResourceFile(rootFor(command.source), scriptPath(command.source, command.name), command.expectedRevision, command.body)
      if (result.kind === "saved") await invalidate(command.source)
      return result
    },
  }
}
