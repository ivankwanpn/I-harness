import { afterEach, expect, it, vi } from 'vitest'
const cleanupIO = vi.hoisted(() => ({ beforeRemove: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => { await cleanupIO.beforeRemove?.(String(args[0])); return fs.rm(...args) } }
})
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createContextOutputService } from '@i-harness/context-output'
import { ContextStore } from '../../context-output/src/store.ts'
import { physicalBytes } from '../../context-output/src/artifact/quota.ts'
import { createCodeRetrievalService } from '@i-harness/code-retrieval'
import type { CodeSnapshotReader } from '@i-harness/code-retrieval'
import { createFileProviderRuntime } from '@i-harness/provider-runtime/file'
import { createContextSubsystemSettings } from '../src/context-subsystems.ts'

const roots: string[] = []; const closes: (() => Promise<void>)[] = []
afterEach(async () => { cleanupIO.beforeRemove = undefined; for (const close of closes.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(reader?: CodeSnapshotReader) {
  const base = resolve('build/plan/context-settings-fixtures'); await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'owned-')); roots.push(root)
  const settingsPath = join(root, 'settings.json')
  const contextOutput = createContextOutputService({ root: join(root, 'context'), workspaceId: 'w' })
  const codeRetrieval = createCodeRetrievalService({ root: join(root, 'code'), workspaceId: 'w', reader: reader ?? { async *snapshots() { yield { sourceId: 'workspace', path: 'a.ts', revision: 'r', text: 'export const needle = 1', complete: true } }, async revalidate() { return true } } })
  closes.push(() => contextOutput.close(), () => codeRetrieval.close())
  const referenceLists: unknown[] = []
  const controller = createContextSubsystemSettings({ settingsPath, workspaceKey: 'host-key', workspaceId: 'w', contextOutput, codeRetrieval, actionSessionId: 'human-owned', onReferencesChanged: async refs => { referenceLists.push(refs) } })
  return { root, settingsPath, contextOutput, codeRetrieval, controller, referenceLists }
}
it('returns a fresh context snapshot after exact-budget cleanup completes with its derived index unavailable', async () => {
  const f = await fixture()
  await f.controller.configure({ scope: 'workspace', contextOutput: { enabled: true } })
  const input = { callId: 'capture', label: 'saved', text: 'original needle', complete: true }
  const a = await f.contextOutput.capture({ ...input, sessionId: 'A' }), b = await f.contextOutput.capture({ ...input, sessionId: 'B', callId: 'survivor' })
  if (!a || !b) throw new Error('Actual caller fixture refused capture')
  const directory = new ContextStore(join(f.root, 'context'), 'w').directory
  const survivorPaths = [join(directory, 'owners', b.id + '.json'), join(directory, 'blobs', b.id + '.txt'), join(directory, 'artifacts', b.id + '.json')]
  const before = await Promise.all(survivorPaths.map(path => readFile(path)))
  const full = await physicalBytes(directory)
  await f.contextOutput.configure({ maxDiskBytes: full })
  expect((await f.controller.state()).context).toMatchObject({ state: 'ready', results: 2 })
  const snapshot = await f.controller.action({ target: 'context', action: 'clear', sessionId: 'A' })
  expect(snapshot.context).toMatchObject({ state: 'error', results: 1, config: { maxDiskBytes: full } })
  expect(snapshot.context.error).toMatch(/requested cleanup completed.*index unavailable/i)
  expect(snapshot.context).toEqual(f.contextOutput.status())
  await expect(readFile(join(directory, 'blobs', a.id + '.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(directory, 'artifacts', a.id + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  for (const [index, path] of survivorPaths.entries()) expect(await readFile(path)).toEqual(before[index])
  expect((await f.contextOutput.read({ sessionId: 'B' }, { refId: b.id })).text).toBe(input.text)
  await expect(f.contextOutput.search({ sessionId: 'B' }, { query: 'needle' })).rejects.toThrow(/index unavailable/i)
  expect(await physicalBytes(directory)).toBeLessThanOrEqual(full)
})
it('propagates the original context cleanup failure through the controller and snapshots incomplete cleanup', async () => {
  const f = await fixture()
  await f.controller.configure({ scope: 'workspace', contextOutput: { enabled: true } })
  const input = { callId: 'capture', label: 'saved', text: 'original needle', complete: true }
  const a = await f.contextOutput.capture({ ...input, sessionId: 'A' }), b = await f.contextOutput.capture({ ...input, sessionId: 'B', callId: 'survivor' })
  if (!a || !b) throw new Error('Actual caller fixture refused capture')
  const directory = new ContextStore(join(f.root, 'context'), 'w').directory
  const survivorPaths = [join(directory, 'owners', b.id + '.json'), join(directory, 'blobs', b.id + '.txt'), join(directory, 'artifacts', b.id + '.json')]
  const before = await Promise.all(survivorPaths.map(path => readFile(path)))
  const fault = Object.assign(new Error('Actual caller canonical body unlink EIO'), { code: 'EIO' })
  const originalManifest = await readFile(join(directory, 'artifacts', a.id + '.json'))
  let cuts = 0
  cleanupIO.beforeRemove = async path => {
    if (path !== join(directory, 'blobs', a.id + '.txt')) return
    cuts++
    expect(JSON.parse(await readFile(join(directory, 'owners', a.id + '.json'), 'utf8'))).toEqual([])
    throw fault
  }
  await expect(f.controller.action({ target: 'context', action: 'clear', sessionId: 'A' })).rejects.toBe(fault)
  expect(cuts).toBe(1)
  const snapshot = await f.controller.state()
  expect(snapshot.context).toMatchObject({ state: 'error', results: 1 })
  expect(snapshot.context.error).toContain(fault.message)
  expect(snapshot.context.error).toContain('Requested original cleanup remains incomplete')
  expect(snapshot.context.error).not.toContain('Requested cleanup completed')
  expect(await readFile(join(directory, 'blobs', a.id + '.txt'), 'utf8')).toBe(input.text)
  expect(await readFile(join(directory, 'artifacts', a.id + '.json'))).toEqual(originalManifest)
  for (const [index, path] of survivorPaths.entries()) expect(await readFile(path)).toEqual(before[index])
  cleanupIO.beforeRemove = undefined
  const recovered = await f.controller.action({ target: 'context', action: 'clear', sessionId: 'A' })
  expect(recovered.context).toMatchObject({ state: 'ready', results: 1 })
  expect(recovered.context.error).toBeUndefined()
  expect((await f.contextOutput.read({ sessionId: 'B' }, { refId: b.id })).text).toBe(input.text)
})
it('persists workspace overrides through the settings lease while preserving provider saves', async () => {
  const f = await fixture()
  const provider = createFileProviderRuntime({ settingsPath: f.settingsPath, credentialsPath: join(f.root, 'credentials.json') })
  await Promise.all([f.controller.configure({ scope: 'workspace', contextOutput: { enabled: true } }), provider.createProvider('test', { protocol: 'openai-completions' })])
  expect(await f.controller.state()).toMatchObject({ source: 'workspace', saved: { contextOutput: { enabled: true }, codeRetrieval: { enabled: false } }, context: { enabled: true } })
  const raw = JSON.parse(await readFile(f.settingsPath, 'utf8')); expect(raw.llm.providers.test).toBeDefined()
  expect(raw.contextSubsystems.contextOutput.enabled).toBe(false)
  await f.controller.configure({ scope: 'workspace', resetOverride: true })
  expect(await f.controller.state()).toMatchObject({ source: 'global', context: { enabled: false } })
})
it('rejects unsupported fields, invalid limits, secret values and implicit reference paths', async () => {
  const f = await fixture()
  for (const patch of [{ scope: 'global', contextOutput: { enabled: 'yes' } }, { scope: 'global', codeRetrieval: { maxFiles: 0 } }, { scope: 'global', codeRetrieval: { ignorePatterns: Array(17).fill('a') } }, { scope: 'global', codeRetrieval: { embedding: { provider: 'ollama', endpoint: 'http://localhost', model: 'm', apiKey: 'SECRET' } } }, { scope: 'global', references: [{ id: 'r', path: '../external', label: 'reference' }] }, { scope: 'global', bad: true }]) await expect(f.controller.configure(patch)).rejects.toThrow()
  expect(await f.controller.state()).toMatchObject({ context: { enabled: false }, code: { enabled: false } })
})
it('applies explicit references, indexes with host actor, and preserves index work during no-op sync', async () => {
  const f = await fixture()
  await f.controller.configure({ scope: 'global', contextOutput: { enabled: true }, codeRetrieval: { enabled: true }, references: [{ id: 'ref', path: f.root, label: 'fixture' }] })
  expect(f.referenceLists.at(-1)).toEqual([{ id: 'ref', path: f.root, label: 'fixture' }])
  await f.controller.action({ target: 'code', action: 'update' })
  const jobId = f.codeRetrieval.status().jobId
  if (jobId) await f.codeRetrieval.wait(jobId)
  expect((await f.controller.sync()).code).toMatchObject({ state: 'ready', files: 1 })
  await f.controller.configure({ scope: 'global', contextOutput: { enabled: false }, codeRetrieval: { enabled: false } })
  expect(await f.controller.state()).toMatchObject({ context: { enabled: false, activeJobs: 0 }, code: { enabled: false, activeJobs: 0 } })
  await f.controller.action({ target: 'code', action: 'clear' })
  expect(f.codeRetrieval.status().generation).toBe(0)
})
it('keeps saved and effective discrepancy after application fails and retries sync', async () => {
  const f = await fixture(); let fail = true
  const controller = createContextSubsystemSettings({ settingsPath: f.settingsPath, workspaceKey: 'host-key', workspaceId: 'w', contextOutput: f.contextOutput, codeRetrieval: f.codeRetrieval, onReferencesChanged: async () => { if (fail) throw new Error('Reference unavailable') } })
  await expect(controller.configure({ scope: 'global', contextOutput: { enabled: true }, references: [{ id: 'r', path: f.root, label: 'ref' }] })).rejects.toThrow('Reference unavailable')
  expect(await controller.state()).toMatchObject({ saved: { contextOutput: { enabled: true } }, context: { enabled: false }, applicationError: 'Reference unavailable' })
  fail = false; expect(await controller.sync()).toMatchObject({ context: { enabled: true } })
  await writeFile(f.settingsPath, JSON.stringify({ contextSubsystems: { codeRetrieval: { enabled: true } } }))
  expect(await controller.sync()).toMatchObject({ code: { enabled: true } })
})
it('does not cancel active indexing during no-op sync and awaits reader drainage when disabled', async () => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve })
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve })
  const f = await fixture({ async *snapshots() { started(); await blocked; yield { sourceId: 'workspace', path: 'slow.ts', revision: 'r', text: 'needle', complete: true } }, async revalidate() { return true } })
  try {
    await f.controller.configure({ scope: 'global', codeRetrieval: { enabled: true } })
    await f.controller.action({ target: 'code', action: 'update' }); await entered
    const before = f.codeRetrieval.status().jobId
    expect((await f.controller.sync()).code).toMatchObject({ state: 'indexing', activeJobs: 1, jobId: before })
    let disabled = false
    const disabling = f.controller.configure({ scope: 'global', codeRetrieval: { enabled: false } }).then(() => { disabled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disabled).toBe(false)
    release(); await disabling
    expect(f.codeRetrieval.status()).toMatchObject({ enabled: false, activeJobs: 0, generation: 0 })
  } finally { release() }
})
it('stores credential references without secret values and rejects model-supplied index actors', async () => {
  const f = await fixture()
  await f.controller.configure({ scope: 'global', codeRetrieval: { mode: 'hybrid', embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'test', credentialRef: 'EMBEDDING_KEY' } } })
  expect((await f.controller.state()).saved.codeRetrieval.embedding?.credentialRef).toBe('EMBEDDING_KEY')
  expect(await readFile(f.settingsPath, 'utf8')).not.toContain('apiKey')
  await expect(f.controller.action({ target: 'code', action: 'update', sessionId: 'model-granted' })).rejects.toThrow('host')
})
it('rejects references that shadow the host-owned workspace source before saving', async () => {
  const f = await fixture()
  await expect(f.controller.configure({ scope: 'workspace', references: [{ id: 'workspace', path: f.root, label: 'shadow' }] })).rejects.toThrow('reserved')
  expect((await f.controller.state()).saved.references).toEqual([])
})
it('rejects over-byte-limit Unicode before saving and round-trips valid Unicode through real services', async () => {
  const f = await fixture()
  const validPattern = '漢'.repeat(341)
  const validIdentity = '漢'.repeat(1365)
  const validReference = 'ENV_' + 'A'.repeat(4092)
  await f.controller.configure({ scope: 'global', codeRetrieval: { ignorePatterns: [validPattern], embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: validIdentity, credentialRef: validReference } } })
  expect((await f.controller.state()).saved.codeRetrieval).toMatchObject({ ignorePatterns: [validPattern], embedding: { model: validIdentity, credentialRef: validReference } })
  expect(f.codeRetrieval.status().config.ignorePatterns).toEqual([validPattern])
  const document = await readFile(f.settingsPath, 'utf8')
  const invalidPatches = [
    { codeRetrieval: { ignorePatterns: ['漢'.repeat(400)] } },
    { codeRetrieval: { embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: '漢'.repeat(1400) } } },
    { codeRetrieval: { embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'valid', credentialRef: '漢'.repeat(1400) } } },
    { codeRetrieval: { embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'valid', credentialRef: 'ENV_' + 'A'.repeat(4093) } } },
  ]
  for (const scope of ['global', 'workspace']) {
    for (const patch of invalidPatches) {
      await expect(f.controller.configure({ scope, ...patch })).rejects.toThrow()
      expect(await readFile(f.settingsPath, 'utf8')).toBe(document)
      expect((await f.controller.state()).applicationError).toBeUndefined()
    }
  }
  await f.controller.configure({ scope: 'workspace', codeRetrieval: { ignorePatterns: ['中文字'], embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: '模型', credentialRef: 'EMBEDDING_KEY' } }, references: [{ id: '資料來源', path: f.root, label: '中文資料' }] })
  expect(await f.controller.sync()).toMatchObject({ code: { config: { embedding: { model: '模型', credentialRef: 'EMBEDDING_KEY' }, ignorePatterns: ['中文字'] } }, saved: { references: [{ id: '資料來源', path: f.root, label: '中文資料' }] } })
})
it.each([
  { contextOutput: { maxPreviewBytes: 4095 } },
  { contextOutput: { maxDiskBytes: 65535 } },
  { codeRetrieval: { maxDiskBytes: 131071 } },
  { codeRetrieval: { ignorePatterns: Array(8).fill('a'.repeat(512)) } },
  { codeRetrieval: { embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'model', credentialRef: 'vault:key' } } },
  { references: [{ id: 'reference', path: 'D:/' + '漢'.repeat(1400), label: 'long path' }] },
])('rejects persisted values outside native reader and credential bounds: %j', async patch => {
  const f = await fixture()
  await f.controller.configure({ scope: 'global' })
  const before = await readFile(f.settingsPath, 'utf8')
  await expect(f.controller.configure({ scope: 'workspace', ...patch })).rejects.toThrow()
  expect(await readFile(f.settingsPath, 'utf8')).toBe(before)
})
