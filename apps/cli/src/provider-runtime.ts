import { dirname, join } from "node:path"
import { createCredentialStore, type CredentialStore } from "@i-harness/credentials"
import type { ProviderRegistry } from "@i-harness/provider"
import {
  createProviderRuntime,
  type ProviderRuntime,
} from "@i-harness/provider-runtime"
import { SettingsStore, resolveSettingsPath } from "@i-harness/settings"
import type { SessionServiceOptions } from "@i-harness/session-executor"
import { createWorkspaceRuntime } from "@i-harness/workspace-runtime"

/** SDK and ACP use the same persisted execution settings as the run surface.
 * Capture configuration synchronously; resolve dependencies only for a new WSL
 * assembly, never during a stdio handshake or for a disabled/native surface.
 */
export function executionServiceOptionsFor(settings: SettingsStore, settingsPath = resolveSettingsPath()): Pick<SessionServiceOptions, "sandbox" | "windowsSandboxBackend" | "wslExecutionFor" | "webSearchMode" | "webCacheRoot"> {
  const saved = settings.get(), backend = process.env.IH_WINDOWS_SANDBOX ?? saved.windowsSandboxBackend
  if (backend !== "legacy" && backend !== "psec" && backend !== "wsl") throw new Error("IH_WINDOWS_SANDBOX requires legacy, psec or wsl")
  const distribution = process.env.IH_WSL_DISTRIBUTION ?? saved.wslExecution.distribution
  const network = process.env.IH_WSL_NETWORK
  const dependencies = process.env.IH_WSL_WORKSPACE_DEPENDENCIES
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(distribution) || distribution.trim() !== distribution) throw new Error("IH_WSL_DISTRIBUTION requires a valid exact distribution name")
  if (network !== undefined && network !== "allow" && network !== "deny") throw new Error("IH_WSL_NETWORK requires allow or deny")
  if (dependencies !== undefined && dependencies !== "true" && dependencies !== "false") throw new Error("IH_WSL_WORKSPACE_DEPENDENCIES requires true or false")
  const configuration = Object.freeze({ distribution, networkAccess: network === undefined ? saved.wslExecution.networkAccess : network === "allow",
    workspaceDependencies: dependencies === undefined ? saved.wslExecution.workspaceDependencies : dependencies === "true" })
  const home = dirname(settingsPath)
  return { sandbox: saved.sandboxMode, windowsSandboxBackend: backend, webSearchMode: saved.webSearchMode, webCacheRoot: join(home, "web-cache"),
    wslExecutionFor: () => {
      if (backend !== "wsl" || !configuration.workspaceDependencies) return configuration
      return createWorkspaceRuntime({ cacheRoot: join(home, "workspace-runtime") }).resolve(configuration, { installIfMissing: true }).then(runtime => {
        if (runtime.status === "unavailable" || runtime.status === "missing") throw new Error(runtime.detail)
        return Object.freeze({ ...configuration, ...(runtime.runtimePath ? { runtimePath: runtime.runtimePath } : {}) })
      })
    },
  }
}

/** Adapt the runtime's model resolution to the assembly's ROLE seam. It is the
 * SAME runtime call the session's own binding makes (`providerModelBindingFor`
 * in index.ts is its session twin); only the selection's origin differs — a
 * role instead of the session's meta.
 *
 * It takes a LOADER rather than a runtime because `run` resolves lazily: a run
 * handed its model (`opts.model`) that never spawns a model-carrying role pays
 * nothing, and the callers that already hold a runtime pass one straight back. */
export function roleModelResolverFor(
  loadRuntime: () => Promise<ProviderRuntime>,
): NonNullable<SessionServiceOptions["resolveRoleModel"]> {
  return async (selection) => (await loadRuntime()).resolveModel({ sessionSelection: selection })
}

/** The two role-model options a host supplies from its settings store: the
 * declared role models (`agents.roles.<name>`) and `plugins.subagentModel`,
 * the switch that lets a role run on one at all.
 *
 * `roleSelectionFor` is a GETTER over the store, never a snapshot of it. That
 * is what makes settings' §3 promise true — the selection is read at SPAWN
 * time, so an edit applies to the next spawn without restarting the session.
 * `plugins.subagentModel`'s own default is false, so an operator who never
 * touches either key gets exactly the behaviour that predates this section. */
export function roleModelOptionsFor(settings: SettingsStore): {
  roleSelectionFor: NonNullable<SessionServiceOptions["roleSelectionFor"]>
  allowSubagentModelSelection: boolean
} {
  return {
    roleSelectionFor: (roleName) => settings.get().agents.roles[roleName],
    allowSubagentModelSelection: settings.get().plugins.subagentModel,
  }
}

export async function loadProviderRuntime(options: {
  settingsPath?: string
  credentialsPath?: string
  registry?: ProviderRegistry
} = {}): Promise<{
  settings: SettingsStore
  credentials: CredentialStore
  runtime: ProviderRuntime
}> {
  const settingsPath = resolveSettingsPath(
    options.settingsPath === undefined ? {} : { path: options.settingsPath },
  )
  const settings = new SettingsStore({ path: settingsPath })
  await settings.load()
  const credentials = createCredentialStore(
    options.credentialsPath ?? join(dirname(settingsPath), "credentials.json"),
  )
  return {
    settings,
    credentials,
    runtime: createProviderRuntime({
      settings,
      credentials,
      ...(options.registry !== undefined ? { registry: options.registry } : {}),
    }),
  }
}
