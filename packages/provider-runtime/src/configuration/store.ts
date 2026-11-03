import type { SettingsStoreSurface, SettingsLlm } from "@i-harness/settings"
import { cloneProviderConfig } from "../directory/merge.ts"

export function canonicalLlm(settings: SettingsStoreSurface): SettingsLlm {
  const mutationBase = settings.getSectionMutationBase?.("llm")
  if (isSettingsLlm(mutationBase)) {
    return {
      providers: Object.fromEntries(
        Object.entries(mutationBase.providers).map(([id, config]) => [id, cloneProviderConfig(config)]),
      ),
      defaultModel: { ...mutationBase.defaultModel },
      ...(mutationBase.videoAudio ? { videoAudio: { ...mutationBase.videoAudio } } : {}),
    }
  }
  const llm = settings.get().llm
  return {
    providers: Object.fromEntries(
      Object.entries(llm.providers).map(([id, config]) => [id, cloneProviderConfig(config)]),
    ),
    defaultModel: { ...llm.defaultModel },
    ...(llm.videoAudio ? { videoAudio: { ...llm.videoAudio } } : {}),
  }
}

function isSettingsLlm(value: unknown): value is SettingsLlm {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.providers === "object" && record.providers !== null
    && !Array.isArray(record.providers)
    && typeof record.defaultModel === "object" && record.defaultModel !== null
    && !Array.isArray(record.defaultModel)
}

export function createLlmPersistence(settings: SettingsStoreSurface): (next: SettingsLlm) => Promise<void> {
  return async (next) => {
    await settings.set({ llm: { ...canonicalLlm(settings), ...next } })
  }
}
