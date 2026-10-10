import { afterEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createNativeContextRuntime } from '../src/context-runtime.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation() })

async function fixture(files = 2094) {
  const base = resolve('build/env-report-retrieval-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'fixture-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'repo')
  await mkdir(workspace)
  await promisify(execFile)('git', ['init', '--quiet', workspace])
  await mkdir(join(workspace, 'src'))
  await writeFile(join(workspace, '.gitignore'), 'ignored.ts\n')
  await writeFile(join(workspace, 'ignored.ts'), 'const neverAdmitted = true')
  await Promise.all(Array.from({ length: files }, (_, i) => writeFile(join(workspace, 'src', `file-${String(i).padStart(4, '0')}.ts`), `export const currentneedle${i} = true\n`)))
  let permitted = true
  const runtime = await createNativeContextRuntime({
    workspace, storageRoot: join(root, 'storage'), codeConfig: { enabled: true },
    coordinator: { profile: async sessionId => ({ meta: { sessionId, formatVersion: 1, createdAt: '2026-10-10T00:00:00Z' }, blank: false }) },
    projectFor: async () => ({ projectId: 'project', scope: { id: 'project', name: 'Project', roots: permitted ? [workspace] : [root], primaryRoot: workspace } }),
  })
  cleanup.push(() => runtime.close())
  const indexed = await runtime.codeRetrieval.wait((await runtime.codeRetrieval.startIndex({ sessionId: runtime.humanSessionId })).jobId)
  expect(indexed).toMatchObject({ state: 'ready', files, partial: false, reasons: [] })
  return { runtime, workspace, revoke: () => { permitted = false } }
}

it('searches current indexed sources in a 2094-file Git workspace through Desktop composition', async () => {
  const { runtime, workspace } = await fixture()
  const started = Date.now()
  const result = await runtime.codeRetrieval.search({ sessionId: 'session' }, { query: 'currentneedle2093' })
  expect(result.hits.map(hit => hit.path)).toEqual(['src/file-2093.ts'])
  expect(result.partial).toBe(false)
  expect(result.hits[0]?.text).toBe(await readFile(join(workspace, 'src/file-2093.ts'), 'utf8'))
  expect(Date.now() - started).toBeLessThan(5000)
}, 30000)

it('reports changed source, live ignore policy, and revoked permission without returning stored text', async () => {
  const { runtime, workspace, revoke } = await fixture(12)
  const query = { query: 'currentneedle11' }
  expect((await runtime.codeRetrieval.search({ sessionId: 'session' }, query)).hits).toHaveLength(1)
  await writeFile(join(workspace, 'src', 'file-0011.ts'), 'export const changedSource = true\n')
  const changed = await runtime.codeRetrieval.search({ sessionId: 'session' }, query)
  expect(changed).toMatchObject({ hits: [], partial: true, reasons: expect.arrayContaining(['source-content-changed']) })
  expect(runtime.codeRetrieval.status()).toMatchObject({ sourceHealth: { scope: 'last-search', state: 'degraded', refusedFiles: 1, reasons: ['source-content-changed'] } })
  await writeFile(join(workspace, 'src', 'file-0011.ts'), 'export const currentneedle11 = true\n')
  await writeFile(join(workspace, 'src', '.gitignore'), 'file-0011.ts\n')
  expect(await runtime.codeRetrieval.search({ sessionId: 'session' }, query)).toMatchObject({ hits: [], partial: true, reasons: expect.arrayContaining(['source-ignored']) })
  await writeFile(join(workspace, 'src', '.gitignore'), '')
  revoke()
  expect(await runtime.codeRetrieval.search({ sessionId: 'session' }, query)).toMatchObject({ hits: [], partial: true, reasons: expect.arrayContaining(['source-unavailable']) })
}, 30000)
