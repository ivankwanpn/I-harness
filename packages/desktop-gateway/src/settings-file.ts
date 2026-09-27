import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { acquireSessionLock } from "@i-harness/fs-lock"
import { SettingsStore } from "@i-harness/settings"

/** Cooperates with file-provider-runtime's lease; load after acquisition so a
 * settings edit cannot replace a concurrently saved provider snapshot. */
export async function withDesktopSettings<T>(path: string, work: (store: SettingsStore) => Promise<T>): Promise<T> {
  const absolute = resolve(path)
  const lockPath = `${process.platform === "win32" ? absolute.toLowerCase() : absolute}.provider.lock`
  const lock = await acquireSessionLock({ lockPath, deadlineMs: 10000 })
  try {
    let raw: string | undefined
    try { raw = await readFile(absolute, "utf8") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read settings document") }
    if (raw !== undefined) {
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { throw new Error("Invalid settings document") }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid settings document")
    }
    const store = new SettingsStore({ path: absolute })
    await store.load()
    return await work(store)
  } finally { await lock.release() }
}
