import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createContextOutputService } from '@i-harness/context-output'
import { createCodeRetrievalService } from '@i-harness/code-retrieval'
import type { CodeSnapshotReader } from '@i-harness/code-retrieval'
import { createFileProviderRuntime } from '@i-harness/provider-runtime/file'
import { createContextSubsystemSettings } from '../src/context-subsystems.ts'

const roots: string[] = []; const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
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
  await f.controller.configure({ scope: 'global', codeRetrieval: { mode: 'hybrid', embedding: { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'test', credentialRef: 'vault:embedding' } } })
  expect((await f.controller.state()).saved.codeRetrieval.embedding?.credentialRef).toBe('vault:embedding')
  expect(await readFile(f.settingsPath, 'utf8')).not.toContain('apiKey')
  await expect(f.controller.action({ target: 'code', action: 'update', sessionId: 'model-granted' })).rejects.toThrow('host')
})
it('rejects references that shadow the host-owned workspace source before saving', async () => {
  const f = await fixture()
  await expect(f.controller.configure({ scope: 'workspace', references: [{ id: 'workspace', path: f.root, label: 'shadow' }] })).rejects.toThrow('reserved')
  expect((await f.controller.state()).saved.references).toEqual([])
})
