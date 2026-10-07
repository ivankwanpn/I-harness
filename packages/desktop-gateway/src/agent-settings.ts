import type { SettingsStore, SettingsSandboxMode, SettingsApprovalMode } from "@i-harness/settings"
import { withDesktopSettings } from "./settings-file.ts"

export interface AgentDefaults { windowsSandboxBackend?: "legacy" | "psec"; sandboxMode: SettingsSandboxMode; autoCompaction: boolean; approvalMode: SettingsApprovalMode }
export interface AgentSettingsState {
  saved: AgentDefaults
  effective: AgentDefaults
  restartRequired: boolean
  source: "settings"
  executions?: readonly { sessionId: string; status: unknown }[]
}

/** Persist settings first, then apply the host's live policy callbacks. A host
 * without a callback keeps reporting its startup policy until rebuilt. */
export function createAgentSettings(path: string, startup: AgentDefaults, options: { executionStatus?(): Promise<readonly { sessionId: string; status: unknown }[]>; onWindowsSandboxBackendChanged?(backend: "legacy" | "psec"): void; onApprovalModeChanged?: (mode: SettingsApprovalMode) => void; onSandboxModeChanged?: (mode: SettingsSandboxMode) => void | Promise<void>; onAutoCompactionChanged?: (enabled: boolean) => void } = {}) {
  const effective = { ...startup, windowsSandboxBackend: startup.windowsSandboxBackend ?? "legacy" }
  const withStore = <T>(work: (store: SettingsStore) => Promise<T>) => withDesktopSettings(path, work)
  async function snapshot(store: SettingsStore): Promise<AgentSettingsState> {
    const value = store.get()
    const saved = { windowsSandboxBackend: value.windowsSandboxBackend, sandboxMode: value.sandboxMode, autoCompaction: value.compaction.auto, approvalMode: value.approvalMode }
    return { executions: await options.executionStatus?.(), saved, effective: { ...effective }, source: "settings", restartRequired: saved.windowsSandboxBackend !== effective.windowsSandboxBackend || saved.sandboxMode !== effective.sandboxMode || saved.autoCompaction !== effective.autoCompaction || saved.approvalMode !== effective.approvalMode }
  }
  async function applyEffective(saved: AgentDefaults): Promise<void> {
    if (saved.windowsSandboxBackend && saved.windowsSandboxBackend !== effective.windowsSandboxBackend && options.onWindowsSandboxBackendChanged) {
      options.onWindowsSandboxBackendChanged(saved.windowsSandboxBackend)
      effective.windowsSandboxBackend = saved.windowsSandboxBackend
    }
    if (saved.autoCompaction !== effective.autoCompaction && options.onAutoCompactionChanged) {
      options.onAutoCompactionChanged(saved.autoCompaction)
      effective.autoCompaction = saved.autoCompaction
    }
    if (saved.sandboxMode !== effective.sandboxMode && options.onSandboxModeChanged !== undefined) {
      await options.onSandboxModeChanged(saved.sandboxMode)
      effective.sandboxMode = saved.sandboxMode
    }
    if (saved.approvalMode !== effective.approvalMode && options.onApprovalModeChanged !== undefined
      && (saved.approvalMode !== "full-access" || effective.sandboxMode === "danger-full-access")) {
      options.onApprovalModeChanged(saved.approvalMode)
      effective.approvalMode = saved.approvalMode
    }
  }
  async function constrain(): Promise<void> {
    if (options.onSandboxModeChanged !== undefined && effective.sandboxMode !== "read-only") {
      await options.onSandboxModeChanged("read-only")
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
        await applyEffective({ windowsSandboxBackend: value.windowsSandboxBackend, sandboxMode: value.sandboxMode, approvalMode: value.approvalMode, autoCompaction: value.compaction.auto })
        return snapshot(store)
      })
    } catch (error) { await constrain(); throw error }
  }
  return {
    state: sync,
    sync,
    async configure(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent settings")
      const input = value as Record<string, unknown>
      if (Object.keys(input).some((key) => !["sandboxMode", "autoCompaction", "approvalMode", "windowsSandboxBackend"].includes(key))) throw new Error("Unknown agent setting")
      if (input.windowsSandboxBackend !== undefined && !["legacy", "psec"].includes(String(input.windowsSandboxBackend))) throw new Error("Invalid Windows sandbox backend")
      if (input.sandboxMode !== undefined && (typeof input.sandboxMode !== "string" || !["read-only", "workspace-write", "danger-full-access"].includes(input.sandboxMode))) throw new Error("Invalid sandbox mode")
      if (input.autoCompaction !== undefined && typeof input.autoCompaction !== "boolean") throw new Error("Invalid auto compaction")
      if (input.approvalMode !== undefined && (typeof input.approvalMode !== "string" || !["dangerous", "ask-all", "delegate", "full-access"].includes(input.approvalMode))) throw new Error("Invalid approval mode")
      if (input.approvalMode === "full-access" && input.sandboxMode !== undefined && input.sandboxMode !== "danger-full-access") throw new Error("Full access requires the full-access sandbox")
      return withStore(async (store) => {
        const nextMode = (input.approvalMode ?? store.get().approvalMode) as SettingsApprovalMode
        const nextSandbox = nextMode === "full-access" ? "danger-full-access" : input.sandboxMode
        if (nextMode === "full-access" && input.sandboxMode !== undefined && input.sandboxMode !== "danger-full-access") throw new Error("Full access requires the full-access sandbox")
        await store.set({
          ...(input.windowsSandboxBackend === undefined ? {} : { windowsSandboxBackend: input.windowsSandboxBackend as "legacy" | "psec" }),
          ...(nextSandbox !== undefined ? { sandboxMode: nextSandbox as SettingsSandboxMode } : {}),
          ...(input.autoCompaction !== undefined ? { compaction: { auto: input.autoCompaction as boolean } } : {}),
          ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode as SettingsApprovalMode } : {}),
        })
        const saved = store.get()
        await applyEffective({ windowsSandboxBackend: saved.windowsSandboxBackend, sandboxMode: saved.sandboxMode, approvalMode: saved.approvalMode, autoCompaction: saved.compaction.auto })
        return snapshot(store)
      })
    },
  }
}
