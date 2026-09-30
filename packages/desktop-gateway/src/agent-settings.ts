import type { SettingsStore, SettingsSandboxMode, SettingsApprovalMode } from "@i-harness/settings"
import { withDesktopSettings } from "./settings-file.ts"

export interface AgentDefaults { sandboxMode: SettingsSandboxMode; autoCompaction: boolean; approvalMode: SettingsApprovalMode }
export interface AgentSettingsState {
  saved: AgentDefaults
  effective: AgentDefaults
  restartRequired: boolean
  source: "settings"
}

/** Persist settings first, then apply the host's live policy callbacks. A host
 * without a callback keeps reporting its startup policy until rebuilt. */
export function createAgentSettings(path: string, startup: AgentDefaults, options: { onApprovalModeChanged?: (mode: SettingsApprovalMode) => void; onSandboxModeChanged?: (mode: SettingsSandboxMode) => void; onAutoCompactionChanged?: (enabled: boolean) => void } = {}) {
  const effective = { ...startup }
  const withStore = <T>(work: (store: SettingsStore) => Promise<T>) => withDesktopSettings(path, work)
  function snapshot(store: SettingsStore): AgentSettingsState {
    const value = store.get()
    const saved = { sandboxMode: value.sandboxMode, autoCompaction: value.compaction.auto, approvalMode: value.approvalMode }
    return { saved, effective: { ...effective }, source: "settings", restartRequired: saved.sandboxMode !== effective.sandboxMode || saved.autoCompaction !== effective.autoCompaction || saved.approvalMode !== effective.approvalMode }
  }
  function applyEffective(saved: AgentDefaults): void {
    if (saved.autoCompaction !== effective.autoCompaction && options.onAutoCompactionChanged) {
      options.onAutoCompactionChanged(saved.autoCompaction)
      effective.autoCompaction = saved.autoCompaction
    }
    if (saved.sandboxMode !== effective.sandboxMode && options.onSandboxModeChanged !== undefined) {
      options.onSandboxModeChanged(saved.sandboxMode)
      effective.sandboxMode = saved.sandboxMode
    }
    if (saved.approvalMode !== effective.approvalMode && options.onApprovalModeChanged !== undefined
      && (saved.approvalMode !== "full-access" || effective.sandboxMode === "danger-full-access")) {
      options.onApprovalModeChanged(saved.approvalMode)
      effective.approvalMode = saved.approvalMode
    }
  }
  function constrain(): void {
    if (options.onSandboxModeChanged !== undefined && effective.sandboxMode !== "read-only") {
      options.onSandboxModeChanged("read-only")
      effective.sandboxMode = "read-only"
    }
    if (options.onApprovalModeChanged !== undefined && effective.approvalMode !== "ask-all") {
      options.onApprovalModeChanged("ask-all")
      effective.approvalMode = "ask-all"
    }
  }
  const sync = async (): Promise<AgentSettingsState> => {
    try {
      return await withStore(async (store) => {
        const value = store.get()
        applyEffective({ sandboxMode: value.sandboxMode, approvalMode: value.approvalMode, autoCompaction: value.compaction.auto })
        return snapshot(store)
      })
    } catch (error) { constrain(); throw error }
  }
  return {
    state: sync,
    sync,
    async configure(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent settings")
      const input = value as Record<string, unknown>
      if (Object.keys(input).some((key) => !["sandboxMode", "autoCompaction", "approvalMode"].includes(key))) throw new Error("Unknown agent setting")
      if (input.sandboxMode !== undefined && (typeof input.sandboxMode !== "string" || !["read-only", "workspace-write", "danger-full-access"].includes(input.sandboxMode))) throw new Error("Invalid sandbox mode")
      if (input.autoCompaction !== undefined && typeof input.autoCompaction !== "boolean") throw new Error("Invalid auto compaction")
      if (input.approvalMode !== undefined && (typeof input.approvalMode !== "string" || !["dangerous", "ask-all", "delegate", "full-access"].includes(input.approvalMode))) throw new Error("Invalid approval mode")
      if (input.approvalMode === "full-access" && input.sandboxMode !== undefined && input.sandboxMode !== "danger-full-access") throw new Error("Full access requires the full-access sandbox")
      return withStore(async (store) => {
        const nextMode = (input.approvalMode ?? store.get().approvalMode) as SettingsApprovalMode
        const nextSandbox = nextMode === "full-access" ? "danger-full-access" : input.sandboxMode
        if (nextMode === "full-access" && input.sandboxMode !== undefined && input.sandboxMode !== "danger-full-access") throw new Error("Full access requires the full-access sandbox")
        await store.set({
          ...(nextSandbox !== undefined ? { sandboxMode: nextSandbox as SettingsSandboxMode } : {}),
          ...(input.autoCompaction !== undefined ? { compaction: { auto: input.autoCompaction as boolean } } : {}),
          ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode as SettingsApprovalMode } : {}),
        })
        const saved = store.get()
        applyEffective({ sandboxMode: saved.sandboxMode, approvalMode: saved.approvalMode, autoCompaction: saved.compaction.auto })
        return snapshot(store)
      })
    },
  }
}
