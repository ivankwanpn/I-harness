import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { acquireSessionLock } from "@i-harness/fs-lock"
import { SettingsStore, type SettingsSandboxMode } from "@i-harness/settings"

export interface AgentDefaults { sandboxMode: SettingsSandboxMode; autoCompaction: boolean }
export interface AgentSettingsState {
  saved: AgentDefaults
  effective: AgentDefaults
  restartRequired: boolean
  source: "settings"
}

/** Narrow adapter over the existing settings store. The host keeps its startup
 * policy until restarted; saving defaults must never imply a live privilege change. */
export function createAgentSettings(path: string, startup: AgentDefaults) {
  const absolute = resolve(path)
  // Same lease as file-provider-runtime: neither cooperating writer can persist
  // a stale whole-document snapshot over changes made by the other.
  const lockPath = `${process.platform === "win32" ? absolute.toLowerCase() : absolute}.provider.lock`
  const effective = { ...startup }
  async function withStore<T>(work: (store: SettingsStore) => Promise<T>): Promise<T> {
    const lock = await acquireSessionLock({ lockPath, deadlineMs: 10000 })
    try {
      let raw: string | undefined
      try { raw = await readFile(absolute, "utf8") }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read agent settings document") }
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
  function snapshot(store: SettingsStore): AgentSettingsState {
    const value = store.get()
    const saved = { sandboxMode: value.sandboxMode, autoCompaction: value.compaction.auto }
    return { saved, effective: { ...effective }, source: "settings", restartRequired: saved.sandboxMode !== effective.sandboxMode || saved.autoCompaction !== effective.autoCompaction }
  }
  return {
    state: () => withStore(async (store) => snapshot(store)),
    async configure(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent settings")
      const input = value as Record<string, unknown>
      if (Object.keys(input).some((key) => !["sandboxMode", "autoCompaction"].includes(key))) throw new Error("Unknown agent setting")
      if (input.sandboxMode !== undefined && (typeof input.sandboxMode !== "string" || !["read-only", "workspace-write", "danger-full-access"].includes(input.sandboxMode))) throw new Error("Invalid sandbox mode")
      if (input.autoCompaction !== undefined && typeof input.autoCompaction !== "boolean") throw new Error("Invalid auto compaction")
      return withStore(async (store) => {
        await store.set({
          ...(input.sandboxMode !== undefined ? { sandboxMode: input.sandboxMode as SettingsSandboxMode } : {}),
          ...(input.autoCompaction !== undefined ? { compaction: { auto: input.autoCompaction as boolean } } : {}),
        })
        return snapshot(store)
      })
    },
  }
}
