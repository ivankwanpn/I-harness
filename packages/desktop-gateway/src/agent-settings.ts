import { normalizeWslExecution, type SettingsStore, type SettingsSandboxMode, type SettingsApprovalMode, type SettingsWindowsSandboxBackend, type SettingsWslExecution, type SettingsWebSearchMode } from "@i-harness/settings"
import { withDesktopSettings } from "./settings-file.ts"
import { validateExecutionSettings } from "./settings-file.ts"

export interface AgentDefaults { windowsSandboxBackend?: SettingsWindowsSandboxBackend; wslExecution?: SettingsWslExecution; webSearchMode?: SettingsWebSearchMode; sandboxMode: SettingsSandboxMode; autoCompaction: boolean; approvalMode: SettingsApprovalMode }
export interface AgentSettingsState {
  saved: AgentDefaults
  effective: AgentDefaults
  restartRequired: boolean
  source: "settings"
  executions?: readonly { sessionId: string; status: unknown }[]
}

/** Persist settings first, then apply the host's live policy callbacks. A host
 * without a callback keeps reporting its startup policy until rebuilt. */
export function createAgentSettings(path: string, startup: AgentDefaults, options: { executionStatus?(): Promise<readonly { sessionId: string; status: unknown }[]>; onWindowsSandboxBackendChanged?(backend: SettingsWindowsSandboxBackend): void; onWslExecutionChanged?(configuration: SettingsWslExecution): void | Promise<void>; onWebSearchModeChanged?(mode: SettingsWebSearchMode): void | Promise<void>; onApprovalModeChanged?: (mode: SettingsApprovalMode) => void; onSandboxModeChanged?: (mode: SettingsSandboxMode) => void | Promise<void>; onAutoCompactionChanged?: (enabled: boolean) => void } = {}) {
  const effective = { ...startup, wslExecution: normalizeWslExecution(startup.wslExecution), windowsSandboxBackend: startup.windowsSandboxBackend ?? "legacy" }
  const withStore = <T>(work: (store: SettingsStore) => Promise<T>) => withDesktopSettings(path, work)
  async function snapshot(store: SettingsStore): Promise<AgentSettingsState> {
    const value = store.get()
    const saved = defaults(value)
    return { executions: await options.executionStatus?.(), saved, effective: { ...effective, wslExecution: { ...effective.wslExecution } }, source: "settings", restartRequired: saved.windowsSandboxBackend !== effective.windowsSandboxBackend || JSON.stringify(saved.wslExecution) !== JSON.stringify(effective.wslExecution) || (effective.webSearchMode !== undefined && saved.webSearchMode !== effective.webSearchMode) || saved.sandboxMode !== effective.sandboxMode || saved.autoCompaction !== effective.autoCompaction || saved.approvalMode !== effective.approvalMode }
  }
  function defaults(value: ReturnType<SettingsStore["get"]>): AgentDefaults {
    return { windowsSandboxBackend: value.windowsSandboxBackend, wslExecution: { ...value.wslExecution }, webSearchMode: value.webSearchMode, sandboxMode: value.sandboxMode, autoCompaction: value.compaction.auto, approvalMode: value.approvalMode }
  }
  async function applyEffective(saved: AgentDefaults): Promise<void> {
    if (saved.wslExecution && JSON.stringify(saved.wslExecution) !== JSON.stringify(effective.wslExecution) && options.onWslExecutionChanged) {
      await options.onWslExecutionChanged({ ...saved.wslExecution })
      effective.wslExecution = { ...saved.wslExecution }
    }
    if (saved.webSearchMode && saved.webSearchMode !== effective.webSearchMode && options.onWebSearchModeChanged) {
      await options.onWebSearchModeChanged(saved.webSearchMode)
      effective.webSearchMode = saved.webSearchMode
    }
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
        await applyEffective(defaults(value))
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
      if (Object.keys(input).some((key) => !["sandboxMode", "autoCompaction", "approvalMode", "windowsSandboxBackend", "wslExecution", "webSearchMode"].includes(key))) throw new Error("Unknown agent setting")
      validateExecutionSettings(input)
      if (input.sandboxMode !== undefined && (typeof input.sandboxMode !== "string" || !["read-only", "workspace-write", "danger-full-access"].includes(input.sandboxMode))) throw new Error("Invalid sandbox mode")
      if (input.autoCompaction !== undefined && typeof input.autoCompaction !== "boolean") throw new Error("Invalid auto compaction")
      if (input.approvalMode !== undefined && (typeof input.approvalMode !== "string" || !["dangerous", "ask-all", "delegate", "full-access"].includes(input.approvalMode))) throw new Error("Invalid approval mode")
      if (input.approvalMode === "full-access" && input.sandboxMode !== undefined && input.sandboxMode !== "danger-full-access") throw new Error("Full access requires the full-access sandbox")
      return withStore(async (store) => {
        const nextMode = (input.approvalMode ?? store.get().approvalMode) as SettingsApprovalMode
        const nextSandbox = nextMode === "full-access" ? "danger-full-access" : input.sandboxMode
        if (nextMode === "full-access" && input.sandboxMode !== undefined && input.sandboxMode !== "danger-full-access") throw new Error("Full access requires the full-access sandbox")
        await store.set({
          ...(input.windowsSandboxBackend === undefined ? {} : { windowsSandboxBackend: input.windowsSandboxBackend as SettingsWindowsSandboxBackend }),
          ...(input.wslExecution === undefined ? {} : { wslExecution: normalizeWslExecution(input.wslExecution) }),
          ...(input.webSearchMode === undefined ? {} : { webSearchMode: input.webSearchMode as SettingsWebSearchMode }),
          ...(nextSandbox !== undefined ? { sandboxMode: nextSandbox as SettingsSandboxMode } : {}),
          ...(input.autoCompaction !== undefined ? { compaction: { auto: input.autoCompaction as boolean } } : {}),
          ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode as SettingsApprovalMode } : {}),
        })
        const saved = store.get()
        await applyEffective(defaults(saved))
        return snapshot(store)
      })
    },
  }
}
