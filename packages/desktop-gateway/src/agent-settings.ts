import type { SettingsStore, SettingsSandboxMode } from "@i-harness/settings"
import { withDesktopSettings } from "./settings-file.ts"

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
  const effective = { ...startup }
  const withStore = <T>(work: (store: SettingsStore) => Promise<T>) => withDesktopSettings(path, work)
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
