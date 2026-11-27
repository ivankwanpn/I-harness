import { normalizeWslExecution, type Settings, type SettingsStore, type SettingsSandboxMode, type SettingsApprovalMode, type SettingsWindowsSandboxBackend, type SettingsWslExecution, type SettingsWebSearchMode } from "@i-harness/settings"
import { withDesktopSettings } from "./settings-file.ts"
import { validateExecutionSettings } from "./settings-file.ts"

export interface AgentDefaults { windowsSandboxBackend?: SettingsWindowsSandboxBackend; wslExecution?: SettingsWslExecution; webSearchMode?: SettingsWebSearchMode; sandboxMode: SettingsSandboxMode; autoCompaction: boolean; approvalMode: SettingsApprovalMode }
export interface AgentSettingsState {
  saved: AgentDefaults
  effective: AgentDefaults
  restartRequired: boolean
  isolatedWorktree?: true
  source: "settings"
  executions?: readonly { sessionId: string; status: unknown }[]
}

export function worktreePermissions(
  saved: Pick<AgentDefaults, "sandboxMode" | "approvalMode">,
  isolatedWorktree?: boolean,
): Pick<AgentDefaults, "sandboxMode" | "approvalMode"> {
  return {
    sandboxMode: isolatedWorktree && saved.sandboxMode === "danger-full-access" ? "workspace-write" : saved.sandboxMode,
    approvalMode: isolatedWorktree && saved.approvalMode === "full-access" ? "dangerous" : saved.approvalMode,
  }
}

/** Persist settings first, then apply the host's live policy callbacks. A host
 * without a callback keeps reporting its startup policy until rebuilt. */
export function createAgentSettings(path: string, startup: AgentDefaults, options: { isolatedWorktree?: boolean; executionStatus?(): Promise<readonly { sessionId: string; status: unknown }[]>; onWindowsSandboxBackendChanged?(backend: SettingsWindowsSandboxBackend): void; onWslExecutionChanged?(configuration: SettingsWslExecution): void | Promise<void>; onWebSearchModeChanged?(mode: SettingsWebSearchMode): void | Promise<void>; onApprovalModeChanged?: (mode: SettingsApprovalMode) => void; onSandboxModeChanged?: (mode: SettingsSandboxMode) => void | Promise<void>; onAutoCompactionChanged?: (enabled: boolean) => void } = {}) {
  const effective = { ...startup, wslExecution: normalizeWslExecution(startup.wslExecution), windowsSandboxBackend: startup.windowsSandboxBackend ?? "legacy" }
  let sandboxApplyPending = false
  const withStore = <T>(work: (store: SettingsStore) => Promise<T>) => withDesktopSettings(path, work)
  function snapshot(value: Settings): AgentSettingsState {
    const saved = defaults(value)
    return { saved, effective: { ...effective, wslExecution: { ...effective.wslExecution } }, ...(options.isolatedWorktree ? { isolatedWorktree: true } : {}), source: "settings", restartRequired: saved.windowsSandboxBackend !== effective.windowsSandboxBackend || JSON.stringify(saved.wslExecution) !== JSON.stringify(effective.wslExecution) || (effective.webSearchMode !== undefined && saved.webSearchMode !== effective.webSearchMode) || saved.sandboxMode !== effective.sandboxMode || saved.autoCompaction !== effective.autoCompaction || saved.approvalMode !== effective.approvalMode }
  }
  async function diagnostics(state: AgentSettingsState): Promise<AgentSettingsState> {
    // Native backend probes can start processes and wait for settlement. They
    // belong to an explicit settings read, after the provider lease is free.
    return { ...state, executions: await options.executionStatus?.() }
  }
  function defaults(value: ReturnType<SettingsStore["get"]>): AgentDefaults {
    return { windowsSandboxBackend: value.windowsSandboxBackend, wslExecution: { ...value.wslExecution }, webSearchMode: value.webSearchMode, autoCompaction: value.compaction.auto, ...worktreePermissions(value, options.isolatedWorktree) }
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
    await applySandboxMode(saved.sandboxMode)
    if (saved.approvalMode !== effective.approvalMode && options.onApprovalModeChanged !== undefined
      && (saved.approvalMode !== "full-access" || effective.sandboxMode === "danger-full-access")) {
      options.onApprovalModeChanged(saved.approvalMode)
      effective.approvalMode = saved.approvalMode
    }
  }
  async function applySandboxMode(mode: SettingsSandboxMode): Promise<void> {
    if (!options.onSandboxModeChanged || (effective.sandboxMode === mode && !sandboxApplyPending)) return
    // A callback may already have fenced the old policy before it reports a
    // failure. The last acknowledged setting cannot prove what is active.
    sandboxApplyPending = true
    await options.onSandboxModeChanged(mode)
    effective.sandboxMode = mode
    sandboxApplyPending = false
  }
  async function constrain(): Promise<void> {
    try { await applySandboxMode("read-only") }
    finally {
      if (options.onApprovalModeChanged !== undefined && effective.approvalMode !== "ask-all") {
        options.onApprovalModeChanged("ask-all")
        effective.approvalMode = "ask-all"
      }
    }
  }
  const sync = async (observe?: (saved: Settings) => void): Promise<AgentSettingsState> => {
    try {
      return await withStore(async (store) => {
        const value = store.get()
        observe?.(value)
        await applyEffective(defaults(value))
        return snapshot(value)
      })
    } catch (error) { await constrain(); throw error }
  }
  return {
    state: async () => diagnostics(await sync()),
    sync,
    async configure(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent settings")
      const input = value as Record<string, unknown>
      if (options.isolatedWorktree && (input.approvalMode === "full-access" || input.sandboxMode === "danger-full-access")) {
        throw new Error("Full access is unavailable in an isolated worktree")
      }
      if (Object.keys(input).some((key) => !["sandboxMode", "autoCompaction", "approvalMode", "windowsSandboxBackend", "wslExecution", "webSearchMode"].includes(key))) throw new Error("Unknown agent setting")
      validateExecutionSettings(input)
      if (input.sandboxMode !== undefined && (typeof input.sandboxMode !== "string" || !["read-only", "workspace-write", "danger-full-access"].includes(input.sandboxMode))) throw new Error("Invalid sandbox mode")
      if (input.autoCompaction !== undefined && typeof input.autoCompaction !== "boolean") throw new Error("Invalid auto compaction")
      if (input.approvalMode !== undefined && (typeof input.approvalMode !== "string" || !["dangerous", "ask-all", "delegate", "full-access"].includes(input.approvalMode))) throw new Error("Invalid approval mode")
      if (input.approvalMode === "full-access" && input.sandboxMode !== undefined && input.sandboxMode !== "danger-full-access") throw new Error("Full access requires the full-access sandbox")
      const state = await withStore(async (store) => {
        const nextMode = (input.approvalMode ?? defaults(store.get()).approvalMode) as SettingsApprovalMode
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
        return snapshot(saved)
      })
      return diagnostics(state)
    },
  }
}
