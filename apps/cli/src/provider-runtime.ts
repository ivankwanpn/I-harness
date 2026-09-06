import { dirname, join } from "node:path"
import { createCredentialStore, type CredentialStore } from "@i-harness/credentials"
import type { ProviderRegistry } from "@i-harness/provider"
import {
  createProviderRuntime,
  type ProviderRuntime,
} from "@i-harness/provider-runtime"
import { SettingsStore, resolveSettingsPath } from "@i-harness/settings"

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
