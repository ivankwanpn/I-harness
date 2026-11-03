import type { GeminiConfig } from '../types.ts'
/** Literal developer generateContent thinking/signatures evidence, 2026-10-16.
 * These rows convey parameter facts, never catalog membership or authenticity. */
const rows: Record<string, { signature: boolean; minimal?: boolean; exclusiveBudgetLevel?: boolean }> = {
  'gemini-3.8-flash': { signature: true, minimal: false },
  'gemini-4-argon': { signature: true, minimal: false, exclusiveBudgetLevel: true },
  'gemini-2.5-flash': { signature: false },
}
export function geminiCapabilities(config: Pick<GeminiConfig, 'baseUrl' | 'model'>) {
  try {
    const url = new URL(config.baseUrl ?? 'https://generativelanguage.googleapis.com')
    if (url.origin !== 'https://generativelanguage.googleapis.com' || !/^\/?$/.test(url.pathname) || url.search || url.hash) return
    return Object.hasOwn(rows, config.model) ? rows[config.model] : undefined
  } catch { return }
}
