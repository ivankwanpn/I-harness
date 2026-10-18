import type { AnthropicConfig } from '../types.ts'
/** Closed literal evidence: Claude thinking/troubleshooting/tool-workflows and
 * model-ids-and-versions, checked 2026-10-16. No family/version extrapolation. */
const rows: Record<string, { modes: readonly string[]; manualInterleaving?: boolean; forcedAdaptive?: boolean; limitedDisabled?: boolean }> = {
  'claude-sonnet-4-5-20250929': { modes: ['enabled', 'disabled'], manualInterleaving: true },
  'claude-sonnet-4-5': { modes: ['enabled', 'disabled'], manualInterleaving: true },
  'claude-haiku-4-5-20251001': { modes: ['enabled', 'disabled'] },
  'claude-sonnet-4-6': { modes: ['enabled', 'adaptive', 'disabled'], manualInterleaving: true },
  'claude-opus-4-6': { modes: ['enabled', 'adaptive', 'disabled'] },
  'claude-opus-4-7': { modes: ['adaptive', 'disabled'] },
  'claude-opus-4-8': { modes: ['adaptive', 'disabled'] },
  'claude-sonnet-5': { modes: ['adaptive', 'disabled'] },
  'claude-opus-5': { modes: ['adaptive', 'disabled'], limitedDisabled: true },
  'claude-haiku-5-5': { modes: ['adaptive', 'disabled'], limitedDisabled: true },
  'claude-fable-5-1': { modes: ['adaptive'], forcedAdaptive: false },
  'claude-opus-5-5': { modes: ['adaptive'], forcedAdaptive: false },
  'claude-sonnet-5-5': { modes: ['adaptive', 'between_tools'], forcedAdaptive: false },
}
export function officialAnthropic(config: Pick<AnthropicConfig, 'baseUrl'>): boolean {
  try { const url = new URL(config.baseUrl ?? 'https://api.anthropic.com'); return url.origin === 'https://api.anthropic.com' && /^\/?$/.test(url.pathname) && !url.search && !url.hash } catch { return false }
}
export function anthropicCapabilities(config: Pick<AnthropicConfig, 'model' | 'baseUrl'>) {
  return officialAnthropic(config) && Object.hasOwn(rows, config.model) ? rows[config.model] : undefined
}
export function hasInterleavedBeta(headers: Record<string, string> | undefined): boolean {
  const value = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === 'anthropic-beta').at(-1)?.[1]
  return value?.split(',').some(token => token.trim() === 'interleaved-thinking-2025-05-14') ?? false
}
