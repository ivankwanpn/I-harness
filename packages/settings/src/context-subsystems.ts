/** Durable structural configuration; no runtime service dependency. */
import { Buffer } from 'node:buffer'
interface SettingsContextOutput {
  enabled: boolean; maxPreviewBytes: number; maxCaptureBytes: number; maxReadBytes: number;
  maxSearchBytes: number; maxDiskBytes: number; retentionDays: number
}
interface SettingsCodeEmbedding {
  provider: 'openai-compatible' | 'ollama'; endpoint: string; model: string; credentialRef?: string; dimensions?: number
}
interface SettingsCodeRetrieval {
  enabled: boolean; mode: 'lexical' | 'hybrid'; autoRefresh: boolean; maxFiles: number; maxFileBytes: number;
  maxInputBytes: number; maxChunks: number; maxDiskBytes: number; maxSearchBytes: number; deadlineMs: number;
  ignorePatterns: string[]; embedding?: SettingsCodeEmbedding
}
export interface SettingsContextReference { id: string; path: string; label: string }
export interface SettingsContextOverride {
  contextOutput?: Partial<SettingsContextOutput>; codeRetrieval?: Partial<SettingsCodeRetrieval>; references?: SettingsContextReference[]
}
export interface SettingsContextSubsystems {
  contextOutput: SettingsContextOutput; codeRetrieval: SettingsCodeRetrieval; references: SettingsContextReference[];
  workspaceOverrides: Record<string, SettingsContextOverride>
}
export const CONTEXT_OUTPUT_DEFAULTS: Readonly<SettingsContextOutput> = Object.freeze({ enabled: false, maxPreviewBytes: 16384, maxCaptureBytes: 8388608, maxReadBytes: 32768, maxSearchBytes: 16384, maxDiskBytes: 536870912, retentionDays: 7 })
export const CODE_RETRIEVAL_DEFAULTS: Readonly<SettingsCodeRetrieval> = Object.freeze({ enabled: false, mode: 'lexical', autoRefresh: false, maxFiles: 20000, maxFileBytes: 1048576, maxInputBytes: 134217728, maxChunks: 50000, maxDiskBytes: 536870912, maxSearchBytes: 16384, deadlineMs: 60000, ignorePatterns: [] })
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown, maxChars = 4096, maxBytes = 4096): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= maxChars && Buffer.byteLength(v, 'utf8') <= maxBytes && !v.includes('\0')
const credentialReference = (v: unknown): v is string => text(v) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)
function embedding(raw: unknown): SettingsCodeEmbedding | undefined {
  const v = record(raw)
  if (!['openai-compatible', 'ollama'].includes(String(v.provider)) || !text(v.model) || !text(v.endpoint)) return undefined
  try { const u = new URL(v.endpoint); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return undefined } catch { return undefined }
  return { provider: v.provider as SettingsCodeEmbedding['provider'], endpoint: v.endpoint, model: v.model,
    ...(credentialReference(v.credentialRef) ? { credentialRef: v.credentialRef } : {}), ...(Number.isSafeInteger(v.dimensions) && Number(v.dimensions) >= 1 && Number(v.dimensions) <= 8192 ? { dimensions: Number(v.dimensions) } : {}) }
}
function config<T extends object>(raw: unknown, defaults: T): Partial<T> {
  const v = record(raw); const out: Record<string, unknown> = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = v[key]
    if (typeof fallback === 'boolean' && typeof value === 'boolean') out[key] = value
    if (typeof fallback === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      const minimum = key === 'retentionDays' ? 0 : key === 'maxPreviewBytes' ? 4096 : key === 'maxDiskBytes' ? ('mode' in defaults ? 131072 : 65536) : key === 'maxSearchBytes' && 'mode' in defaults ? 128 : 1
      out[key] = Math.min(key === 'retentionDays' ? 36500 : 2147483647, Math.max(minimum, Math.floor(value)))
    }
    if (key === 'mode' && (value === 'lexical' || value === 'hybrid')) out[key] = value
    if (key === 'ignorePatterns' && Array.isArray(value)) {
      // Reserve 512 characters for the native reader's include/revalidation filter.
      let chars = 0
      out[key] = value.filter(p => {
        if (!text(p, 512, 1024) || chars + p.length > 3584) return false
        chars += p.length
        return true
      }).slice(0, 16)
    }
  }
  if ('mode' in defaults) { const e = embedding(v.embedding); if (e) out.embedding = e }
  return out as Partial<T>
}
function references(raw: unknown): SettingsContextReference[] {
  if (!Array.isArray(raw)) return []
  const ids = new Set<string>()
  return raw.slice(0, 100).flatMap(item => {
    const v = record(item)
    if (!text(v.id, 256) || !text(v.path) || !text(v.label, 256) || ids.has(v.id) || ['workspace', '__proto__', 'constructor', 'prototype'].includes(v.id)) return []
    if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(v.path)) return []
    ids.add(v.id); return [{ id: v.id, path: v.path, label: v.label }]
  })
}
export function normalizeContextSubsystems(raw: unknown): SettingsContextSubsystems {
  const v = record(raw); const overrides: SettingsContextSubsystems['workspaceOverrides'] = {}
  const codeRetrieval = { ...CODE_RETRIEVAL_DEFAULTS, ignorePatterns: [], ...config(v.codeRetrieval, CODE_RETRIEVAL_DEFAULTS) }
  if (codeRetrieval.mode === 'hybrid' && !codeRetrieval.embedding) codeRetrieval.mode = 'lexical'
  for (const [key, value] of Object.entries(record(v.workspaceOverrides))) {
    if (!text(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue
    const row = record(value)
    overrides[key] = { ...(row.contextOutput !== undefined ? { contextOutput: config(row.contextOutput, CONTEXT_OUTPUT_DEFAULTS) } : {}), ...(row.codeRetrieval !== undefined ? { codeRetrieval: config(row.codeRetrieval, CODE_RETRIEVAL_DEFAULTS) } : {}), ...(row.references !== undefined ? { references: references(row.references) } : {}) }
    const overrideCode = overrides[key]!.codeRetrieval
    if (overrideCode?.mode === 'hybrid' && !overrideCode.embedding && !codeRetrieval.embedding) overrideCode.mode = 'lexical'
  }
  return { contextOutput: { ...CONTEXT_OUTPUT_DEFAULTS, ...config(v.contextOutput, CONTEXT_OUTPUT_DEFAULTS) }, codeRetrieval, references: references(v.references), workspaceOverrides: overrides }
}
