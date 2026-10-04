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
  expect(settings.contextOutput.maxPreviewBytes).toBe(1)
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
