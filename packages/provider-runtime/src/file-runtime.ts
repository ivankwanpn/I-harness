import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createCredentialStore } from "@i-harness/credentials"
import { acquireSessionLock, type SessionLock } from "@i-harness/fs-lock"
import { SettingsStore } from "@i-harness/settings"
import { createProviderRuntime, type ProviderRuntime } from "./index.ts"

export interface FileProviderRuntimeOptions {
  settingsPath: string
  credentialsPath: string
}

async function validateDocument(path: string): Promise<void> {
  let raw: string
  try { raw = await readFile(path, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error("Cannot read provider configuration document")
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error()
  } catch { throw new Error("Invalid provider configuration document") }
}

/** Serialized file-backed entry point for cooperating local hosts. Existing
 * in-memory runtimes remain suitable for injected stores. Never exposes files
 * or credentials through its return value; all operations use the same runtime.
 * Both file locks are ordered, including when distinct settings share credentials.
 */
export function createFileProviderRuntime(options: FileProviderRuntimeOptions): ProviderRuntime {
  const paths = [...new Set([options.settingsPath, options.credentialsPath].map((path) => {
    const absolute = resolve(path)
    return process.platform === "win32" ? absolute.toLowerCase() : absolute
  }))].sort()
  const settings = new SettingsStore({ path: options.settingsPath })
  const runtime = createProviderRuntime({ settings, credentials: createCredentialStore(options.credentialsPath) })
  let tail: Promise<unknown> = Promise.resolve()
  const result = {} as ProviderRuntime
  for (const key of Object.keys(runtime) as (keyof ProviderRuntime)[]) {
    const method = runtime[key] as (...args: unknown[]) => Promise<unknown>
    Object.defineProperty(result, key, { enumerable: true, value: (...args: unknown[]) => {
      const job = tail.then(async () => {
        const locks: SessionLock[] = []
        try {
          for (const path of paths) locks.push(await acquireSessionLock({ lockPath: `${path}.provider.lock`, deadlineMs: 10000 }))
          for (const path of paths) await validateDocument(path)
          await settings.load()
          if (key === "probeModels") {
            // A read-only network probe uses its own settings snapshot. Release
            // shared file locks before waiting for an endpoint response.
            const snapshot = new SettingsStore({ path: options.settingsPath })
            await snapshot.load()
            const probeRuntime = createProviderRuntime({ settings: snapshot, credentials: createCredentialStore(options.credentialsPath) })
            return { invoke: () => (probeRuntime.probeModels as (...values: unknown[]) => Promise<unknown>)(...args) }
          }
          return { value: await method(...args) }
        } finally {
          for (const lock of locks.reverse()) await lock.release()
        }
      })
      tail = job.catch(() => undefined)
      return job.then((result) => result.invoke !== undefined ? result.invoke() : result.value)
    } })
  }
  return result
}
