import {AsyncLocalStorage} from 'node:async_hooks'
import { resolve } from "node:path"
import { FsWatchError, type FsWatchService } from "@i-harness/fs-watch"
import { createManagedPluginRegistry } from "@i-harness/plugin-registry/managed"

export type PluginCommand =
  | { action: "source/add"; source: string }
  | { action: "source/refresh" | "source/remove"; name: string }
  | { action: "install" | "uninstall" | "enable" | "disable"; id: string }
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) throw new Error("Invalid plugin parameter")
  return value
}
export function createDesktopPlugins(root: string, options: { watch: FsWatchService }) {
  let watchError: string | undefined
  const managed = createManagedPluginRegistry({ root }, { acquireStateWatch(path) {
    const lease = options.watch.acquire({ roots: [path], persistent: false })
    const normalize = (value: string) => { const absolute = resolve(value); return process.platform === "win32" ? absolute.toLowerCase() : absolute }
    const selected = normalize(path)
    return { ready: lease.ready, close: () => lease.close(), subscribe: listener => lease.subscribe(event => {
      if (event.kind === "unavailable") { const error = new FsWatchError(event.code, `Plugin state watch unavailable: ${event.code}`); watchError = String(error); listener({ kind: "unavailable", error }) }
      else if (event.kind === "reset") { watchError = undefined; listener({ kind: "reset" }) }
      else if (event.changes.some(change => normalize(change.path) === selected)) listener({ kind: "changed" })
    }) }
  } })
  const diagnostics = new Map<string, string[]>()
  let refresh: (() => Promise<void>) | undefined
  let refreshError: string | undefined
  let refreshTail: Promise<void> = Promise.resolve()
  const refreshScope=new AsyncLocalStorage<{token?:object;active:boolean}>(),mutationTokens=new Set<object>()
  const refreshLive = (token?:object) => {
    const job = refreshTail.catch(() => undefined).then(async () => { const scope={token,active:true};try{await refreshScope.run(scope,async()=>{await refresh?.()});refreshError=undefined}finally{scope.active=false} })
    refreshTail = job.catch((error: unknown) => { refreshError = String(error) })
    return job
  }
  let mutationAdmissionClosed = false
  const mutations = new Set<Promise<{ ok: boolean }>>()
  const mutate = async (value: unknown, token:object) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin command")
    const command = value as Record<string, unknown>
    await managed.run(async (registry) => {
      switch (command.action) {
        case "source/add": await registry.addSource(text(command.source)); break
        case "source/refresh": await registry.refreshSource(text(command.name)); break
        case "source/remove": await registry.removeSource(text(command.name)); break
        case "install": await registry.install(text(command.id)); break
        case "uninstall": await registry.uninstall(text(command.id)); break
        case "enable": await registry.enable(text(command.id)); break
        case "disable": await registry.disable(text(command.id)); break
        default: throw new Error("Unknown plugin command")
      }
      return { ok: true }
    })
    try { await refreshLive(token) }
    catch { throw new Error("Plugin settings were saved, but live update failed; retry the operation") }
    return { ok: true }
  }
  return {
    refresh: () => refreshLive(),
    async state() {
      // Self-heal a stale refresh error: a watcher can miss the last event when
      // the registry path is replaced (for example a file briefly becoming a
      // directory), leaving a permanent error in the UI until restart.
      if (refreshError !== undefined) await refreshLive().catch(() => {})
      return managed.run(async (registry) => ({ sources: await registry.listSources({ fetchMissing: false }), ...(await registry.catalog({ fetchMissing: false })), diagnostics: Object.fromEntries(diagnostics), ...((watchError ?? refreshError) !== undefined ? { refreshError: watchError ?? refreshError } : {}) }))
    },
    bindRefresh(callback: () => Promise<void>) { refresh = callback; return managed.observe(() => refreshLive(), (error) => { refreshError = String(error) }) },
    commands: () => managed.run((registry) => registry.runtimeInputs().commandDescriptors.map(({ name, description, argumentHints }) => ({ name, description, argumentHints }))),
    report(sessionId: string, messages: string[]) {
      diagnostics.delete(sessionId); diagnostics.set(sessionId, messages.slice(-100))
      while (diagnostics.size > 100) diagnostics.delete(diagnostics.keys().next().value!)
    },
    inputs: () => managed.run((registry) => registry.runtimeInputs()),
    /** A synchronous original-registry witness for pre-acquisition selection.
     * It carries no mount or execution authority. */
    inputsWitness: () => managed.run((registry) => {
      if(mutationAdmissionClosed||[...mutationTokens].some(token=>!refreshScope.getStore()?.active||refreshScope.getStore()?.token!==token))throw new Error('Plugin mutation pending during selection')
      const method=registry.runtimeInputs,inputs=structuredClone(method.call(registry)),snapshot=JSON.stringify(inputs)
      return Object.freeze({inputs,assertCurrent(){
        if(mutationAdmissionClosed||[...mutationTokens].some(token=>!refreshScope.getStore()?.active||refreshScope.getStore()?.token!==token)||registry.runtimeInputs!==method||JSON.stringify(inputs)!==snapshot||JSON.stringify(method.call(registry))!==snapshot)throw new Error('Plugin inputs changed after selection')
      }})
    }),
    mutate(value: unknown) {
      if (mutationAdmissionClosed) return Promise.reject(new Error("Plugin registry is closed"))
      // Own the operation through its post-lock refresh, not just managed.run.
      const token={},job = mutate(value,token)
      mutationTokens.add(token);mutations.add(job)
      void job.then(() => {mutationTokens.delete(token);mutations.delete(job)}, () => {mutationTokens.delete(token);mutations.delete(job)})
      return job
    },
    close: async () => {
      managed.assertCanClose()
      mutationAdmissionClosed = true
      const results = await Promise.allSettled([managed.close(), refreshTail, ...mutations])
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, "Plugin cleanup failed")
    },
  }
}
