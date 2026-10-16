import type { ModelDescriptor } from "@i-harness/provider"
import type { SettingsModel, SettingsProviderConfig } from "@i-harness/settings"

export function mergeModels(
  base: readonly ModelDescriptor[],
  overrides: readonly SettingsModel[],
): ModelDescriptor[] {
  const models = new Map<string, ModelDescriptor>()
  for (const model of base) models.set(model.id, { ...model })
  for (const model of overrides) {
    models.set(model.id, { ...models.get(model.id), ...model })
  }
  return [...models.values()]
}

export function mergeDiscoveredModels(
  manual: readonly SettingsModel[],
  probe: readonly ModelDescriptor[],
): SettingsModel[] {
  const models = new Map<string, SettingsModel>()
  for (const model of manual) models.set(model.id, { ...model })
  for (const model of probe) {
    const existing = models.get(model.id)
    models.set(model.id, existing === undefined ? { ...model } : { ...model, ...existing })
  }
  return [...models.values()]
}

export function cloneModels(models: readonly ModelDescriptor[]): ModelDescriptor[] {
  return models.map((model) => ({ ...model }))
}

export function cloneProviderConfig(config: SettingsProviderConfig): SettingsProviderConfig {
  return {
    ...config,
    ...(config.promptCache !== undefined ? { promptCache: { ...config.promptCache } } : {}),
    ...(config.models !== undefined ? { models: config.models.map((model) => ({ ...model })) } : {}),
  }
}
