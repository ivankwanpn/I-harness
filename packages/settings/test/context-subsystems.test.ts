import { expect, it } from 'vitest'
import { normalizeSettings, normalizeContextSubsystems } from '../src/index.ts'

it('loads old documents with independent services disabled and bounded defaults', () => {
  const settings = normalizeSettings({ model: 'old' }).contextSubsystems
  expect(settings.contextOutput).toMatchObject({ enabled: false, maxPreviewBytes: 16384, maxCaptureBytes: 8388608, maxReadBytes: 32768, maxDiskBytes: 536870912, retentionDays: 7 })
  expect(settings.codeRetrieval).toMatchObject({ enabled: false, autoRefresh: false, mode: 'lexical', maxFiles: 20000, maxInputBytes: 134217728, maxChunks: 50000, deadlineMs: 60000 })
  expect(settings.references).toEqual([])
})
it('normalizes workspace overrides without filling absent overrides or retaining secrets', () => {
  const settings = normalizeContextSubsystems({ contextOutput: { enabled: true, maxPreviewBytes: -1 }, codeRetrieval: { embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'test', apiKey: 'SECRET' } }, workspaceOverrides: { hostKey: { codeRetrieval: { enabled: true } } } })
  expect(settings.contextOutput.maxPreviewBytes).toBe(4096)
  expect(settings.workspaceOverrides.hostKey).toEqual({ codeRetrieval: { enabled: true } })
  expect(JSON.stringify(settings)).not.toContain('SECRET')
})
it('inherits a global embedding configuration when a workspace selects hybrid mode', () => {
  const settings = normalizeContextSubsystems({ codeRetrieval: { embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'test' } }, workspaceOverrides: { host: { codeRetrieval: { mode: 'hybrid' } } } })
  expect(settings.workspaceOverrides.host?.codeRetrieval?.mode).toBe('hybrid')
})
it('drops relative reference roots and the reserved workspace source from old files', () => {
  const settings = normalizeContextSubsystems({ references: [{ id: 'relative', path: '../implicit', label: 'relative' }, { id: 'workspace', path: 'D:/source', label: 'shadow' }, { id: 'explicit', path: 'D:/source', label: 'explicit' }] })
  expect(settings.references).toEqual([{ id: 'explicit', path: 'D:/source', label: 'explicit' }])
})
it('falls back to lexical for a hybrid override without an inherited embedding', () => {
  expect(normalizeContextSubsystems({ workspaceOverrides: { host: { codeRetrieval: { mode: 'hybrid' } } } }).workspaceOverrides.host?.codeRetrieval?.mode).toBe('lexical')
})
it('filters over-byte-limit Unicode while preserving valid values in globals and overrides', () => {
  const raw = { mode: 'hybrid', ignorePatterns: ['漢'.repeat(400), '漢'.repeat(341)], embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: '漢'.repeat(1400) } }
  const settings = normalizeContextSubsystems({ codeRetrieval: raw, workspaceOverrides: { host: { codeRetrieval: raw } } })
  expect(settings.codeRetrieval.ignorePatterns).toEqual(['漢'.repeat(341)])
  expect(settings.codeRetrieval.embedding).toBeUndefined()
  expect(settings.codeRetrieval.mode).toBe('lexical')
  expect(settings.workspaceOverrides.host?.codeRetrieval).toMatchObject({ mode: 'lexical', ignorePatterns: ['漢'.repeat(341)] })
})
it('normalizes native storage and preview floors, combined filters and credential reference grammar', () => {
  const settings = normalizeContextSubsystems({ contextOutput: { maxPreviewBytes: 1, maxDiskBytes: 1 }, codeRetrieval: { maxDiskBytes: 1, ignorePatterns: Array(8).fill('a'.repeat(512)), embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'model', credentialRef: 'vault:key' } } })
  expect(settings.contextOutput).toMatchObject({ maxPreviewBytes: 4096, maxDiskBytes: 65536 })
  expect(settings.codeRetrieval.maxDiskBytes).toBe(131072)
  expect(settings.codeRetrieval.ignorePatterns.reduce((sum, value) => sum + value.length, 0)).toBeLessThanOrEqual(3584)
  expect(settings.codeRetrieval.embedding?.credentialRef).toBeUndefined()
})
