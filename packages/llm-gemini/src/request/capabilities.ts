import type { GeminiConfig } from '../types.ts'
import { geminiModelId, geminiModelsURL } from '../url.ts'
/** Literal developer generateContent thinking/signatures evidence, 2026-10-16.
 * These rows convey parameter facts, never catalog membership or authenticity. */
const rows: Record<string, { signature: boolean; minimal?: boolean; exclusiveBudgetLevel?: boolean }> = {
  'gemini-3.8-flash': { signature: true, minimal: false },
  'gemini-4-argon': { signature: true, minimal: false, exclusiveBudgetLevel: true },
  'gemini-2.5-flash': { signature: false },
}
function officialModel(config: Pick<GeminiConfig, 'baseUrl' | 'model'>): string | undefined {
  try {
    if (new URL(geminiModelsURL(config.baseUrl)).href === geminiModelsURL()) return geminiModelId(config.model)
  } catch { /* A custom route cannot establish Google's model capabilities. */ }
}
export function officialGeminiGeneration(config: Pick<GeminiConfig, 'baseUrl' | 'model'>): number | undefined {
  const generation = /^gemini-(\d+)(?:[.-]|$)/.exec(officialModel(config) ?? '')
  return generation ? Number(generation[1]) : undefined
}
export const supportsFunctionResponseImage = (mime: unknown): boolean => mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp'
export function geminiCapabilities(config: Pick<GeminiConfig, 'baseUrl' | 'model'>) {
  const model = officialModel(config)
  return model && Object.hasOwn(rows, model) ? rows[model] : undefined
}
