import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import { createMcpConfigStore, type McpSecretPatch, type PublicMcpConfig } from "@i-harness/mcp-client/config"
export type McpSettingsCommand = { action: "save"; config: PublicMcpConfig; secrets?: McpSecretPatch; revision: number } | { action: "enable" | "disable" | "remove"; name: string }
export function createDesktopMcp(path: string) {
  const store = createMcpConfigStore(path)
  const refreshers = new Set<{ apply(): Promise<void> }>()
  let appliedFingerprint: string | undefined
  let applyError: string | undefined
  const scopes = new AsyncLocalStorage<{ token?: object; active: boolean }>()
  let mutation: object | undefined
  const assertMutation = () => {
    const scope = scopes.getStore()
    if (mutation && (!scope?.active || scope.token !== mutation)) throw Error('MCP mutation pending')
  }
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  const missing = (error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error }
  const fingerprint = () => { try { return hash(readFileSync(path)) } catch (error) { return missing(error) } }
  const readFingerprint = () => readFile(path).then(hash, missing)
  const state = async () => ({ servers: await store.list(), ...(applyError ? { applyError } : {}) })
  // A profile operation owns both the saved revision and its live publication.
  // Subsequent writes must wait until this fanout has finished.
  let chain: Promise<void> = Promise.resolve()
  let closed = false
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("MCP settings are closed"))
    const result = chain.then(operation)
    chain = result.then(() => {}, () => {})
    return result
  }
  async function apply(observed: boolean, token?: object): Promise<void> {
    const scope = { token, active: true }
    try {
      const revision = await readFingerprint()
      if (observed && revision === appliedFingerprint && applyError === undefined) return
      const targets = [...refreshers]
      const results = await scopes.run(scope, () => Promise.allSettled(targets.map(async target => {
        if (refreshers.has(target)) await target.apply()
      })))
      if (results.some((result, index) => result.status === "rejected" && refreshers.has(targets[index]!)) || await readFingerprint() !== revision) {
        throw new Error("MCP settings publication did not settle")
      }
      appliedFingerprint = revision
      applyError = undefined
    } catch {
      applyError = "MCP settings were saved, but live application failed. Retry after checking the server configuration."
      throw new Error(applyError)
    } finally { scope.active = false }
  }
  return {
    state,
    refresh: () => enqueue(async () => { await apply(false); return state() }),
    observeChange: () => enqueue(() => apply(true)),
    active: store.active,
    snapshot: () => store.active(),
    async activeWitness() {
      assertMutation()
      const before = fingerprint()
      const configs = await store.active()
      const after = fingerprint()
      assertMutation()
      if (before !== after) throw Error("MCP settings changed during selection")
      const snapshot = JSON.stringify(configs)
      return Object.freeze({
        configs,
        assertCurrent() {
          assertMutation()
          if (fingerprint() !== after || JSON.stringify(configs) !== snapshot) {
            throw Error("MCP settings changed after selection")
          }
        },
      })
    },
    bindRefresh(callback: () => Promise<void>) {
      if (closed) throw new Error("MCP settings are closed")
      const target = { apply: callback }
      refreshers.add(target)
      return () => { refreshers.delete(target) }
    },
    mutate(value: unknown) {
      return enqueue(async () => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP settings command")
        const command = value as Record<string, unknown>, token = {}
        mutation = token
        try {
          if (command.action === "save") {
            if (!Number.isSafeInteger(command.revision) || (command.revision as number) < 0) throw new Error("MCP revision required")
            await store.save(command.config, command.secrets as McpSecretPatch | undefined, command.revision as number)
          } else {
            if (typeof command.name !== "string" || !command.name || command.name.length > 64) throw new Error("Invalid MCP server name")
            if (command.action === "remove") await store.remove(command.name)
            else if (command.action === "enable" || command.action === "disable") await store.setEnabled(command.name, command.action === "enable")
            else throw new Error("Unknown MCP operation")
          }
          try { await apply(false, token) } catch { /* The saved settings and apply error are returned together. */ }
          return await state()
        } finally { mutation = undefined }
      })
    },
    close() {
      closed = true
      return chain
    },
  }
}
