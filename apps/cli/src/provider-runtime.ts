import { dirname, join } from "node:path"
import { createCredentialStore, type CredentialStore } from "@i-harness/credentials"
import type { ProviderRegistry } from "@i-harness/provider"
import {
  createProviderRuntime,
  type ProviderRuntime,
} from "@i-harness/provider-runtime"
import { SettingsStore, resolveSettingsPath } from "@i-harness/settings"
import type { SessionServiceOptions } from "@i-harness/session-executor"

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
