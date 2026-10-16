import type { ModelDescriptor, ProviderProfile } from "@i-harness/provider"
import type { SettingsProviderConfig, SettingsProviderProtocol, SettingsInputModality, SettingsMaxTokensField } from "@i-harness/settings"

export interface ProviderView {
  id: string
  template?: ProviderProfile
  user?: SettingsProviderConfig
  displayName: string
  /** Absent = nobody declared one; see resolveProviderProtocol. */
  protocol?: SettingsProviderProtocol
  baseURL?: string
  modelsURL?: string
  apiKeyEnv?: string
  /** The model-card family this route draws capability metadata from. Absent →
   * the route name (see ProviderProfile.catalog). */
  catalog?: string
  /** M59: literal extra request headers (user config wins over the template). */
  headers?: Record<string, string>
  /** Legacy route declaration, projected only onto listed models that lack an
   * explicit modality; new Desktop settings write model rows only. */
  inputModalities?: SettingsInputModality[]
  /** M72 Ⅱ: the ROUTE's chosen output-cap field name (user config wins over
   * the template; absent → the adapter's own default). */
  maxTokensField?: SettingsMaxTokensField
  /** M72 Ⅲ: the ROUTE's usage ask (user config wins over the template; absent
   * → the adapter's own default, which is ON). */
  usageInStream?: boolean
  promptCache?: SettingsProviderConfig["promptCache"]
  models: ModelDescriptor[]
  defaultModel?: string
}
