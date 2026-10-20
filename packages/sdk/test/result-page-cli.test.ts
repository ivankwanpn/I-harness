import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { acquireAssemblyResultStore } from '../../session-executor/src/lifecycle/result-store.ts'
import { HarnessClient } from '../src/client.ts'

it('injects the real CLI cold reader and refuses a saved project binding without confirmed scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'result-cli-')), store = join(root, 'sessions'), config = join(root, 'config'), workspace = join(root, 'workspace')
  await mkdir(config); await mkdir(workspace); const settings = join(config, 'settings.json'); await writeFile(settings, '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } }), refs: Record<string, any> = {}
  for (const id of ['unbound', 'bound']) {
    await coordinator.create({ sessionId: id }); await coordinator.flush(id)
    if (id === 'bound') await coordinator.putDocument('desktop-session-project-' + createHash('sha256').update(id).digest('hex'), { version: 1, projectId: 'p' })
    const lease = await acquireAssemblyResultStore({ workspace, coordinator, sessionId: id, contextOutputSettingsPath: settings, ...(id === 'bound' ? { projectContext: () => ({ id: 'p', roots: [workspace] }) } : {}) })
    const owner = lease.service!, scope = owner.registerResultScope({ operationId: id, sessionId: id, callId: 'c', source: await lease.sourceFor!(id) }, () => true)
    const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from(id + ' bytes'))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Original fixture refused')
    refs[id] = saved.ref; await lease.release()
  }
  await coordinator.close()
  const repo = resolve(import.meta.dirname, '../../..'), loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href
  const client = HarnessClient.spawn({ command: process.execPath, args: ['--import', loader, join(repo, 'apps/cli/src/index.ts'), 'sdk', '--session-dir', store], cwd: workspace, env: { IH_CONFIG_DIR: config } })
  try {
    const before = await Promise.all(['unbound', 'bound'].map(id => readFile(join(store, id + '.jsonl'))))
    expect((await client.initialize()).capabilities['session-result-read']).toEqual(['1'])
    expect(await client.readResultPage('unbound', { ref: refs.unbound })).toMatchObject({ ref: refs.unbound, eof: true, data: { text: 'unbound bytes' } })
    expect(await client.readResultPage('bound', { ref: refs.bound })).toMatchObject({ kind: 'unavailable' })
    expect(await Promise.all(['unbound', 'bound'].map(id => readFile(join(store, id + '.jsonl'))))).toEqual(before)
    expect(await readFile(settings, 'utf8')).toBe('{}')
  } finally { await client.close(); await rm(root, { recursive: true, force: true }) }
}, 20000)
