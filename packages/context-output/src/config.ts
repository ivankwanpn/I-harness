import type { ContextOutputConfig } from './types.ts'

export const DEFAULT_CONTEXT_OUTPUT_CONFIG: Readonly<ContextOutputConfig> = Object.freeze({
  enabled: false, maxPreviewBytes: 16 * 1024, maxCaptureBytes: 8 * 1024 * 1024,
  maxReadBytes: 32 * 1024, maxSearchBytes: 16 * 1024, maxDiskBytes: 512 * 1024 * 1024,
  retentionDays: 7,
})

export function configureContext(current: ContextOutputConfig, patch: Partial<ContextOutputConfig>): ContextOutputConfig {
  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULT_CONTEXT_OUTPUT_CONFIG)) throw new Error(`Unknown Context config: ${key}`)
  }
  const config = { ...current, ...patch }
  if (typeof config.enabled !== 'boolean') throw new Error('enabled must be boolean')
  for (const key of ['maxPreviewBytes', 'maxCaptureBytes', 'maxReadBytes', 'maxSearchBytes', 'maxDiskBytes'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive safe integer`)
  }
  if (!Number.isFinite(config.retentionDays) || config.retentionDays < 0 || config.retentionDays > 36500) {
    throw new Error('retentionDays must be between 0 and 36500')
  }
  return config
}

export function identity(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 1024 || value.includes('\0')) {
    throw new Error(`${name} must be a non-empty identity of at most 1024 UTF-8 bytes`)
  }
}

export function integer(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return value
}
