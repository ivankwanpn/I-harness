import { afterEach, expect, it, vi } from 'vitest'
const controls = vi.hoisted(() => ({ settings: undefined as undefined | (() => Promise<void>), afterSettings: undefined as undefined | (() => void), afterLocation: undefined as undefined | (() => void), page: undefined as undefined | (() => Promise<void>), close: undefined as undefined | (() => Promise<void>), owners: [] as import('@i-harness/context-output').ContextOutputService[] }))
vi.mock('@i-harness/context-output', async original => {
  const native = await original<typeof import('@i-harness/context-output')>()
  return { ...native,
    contextWorkspaceLocation: (...args: Parameters<typeof native.contextWorkspaceLocation>) => ({ then(resolve: (value: unknown) => void, reject: (cause: unknown) => void) {
      void native.contextWorkspaceLocation(...args).then(value => { resolve(value); if (controls.afterLocation) { const hook = controls.afterLocation; controls.afterLocation = undefined; queueMicrotask(hook) } }, reject)
    } }),
    loadContextOutputConfiguration: (...args: Parameters<typeof native.loadContextOutputConfiguration>) => {
      // A thenable schedules final-owner release precisely after the caller
      // resumes settings, before its await of the already-resolved entry.
      const work = (async () => { await controls.settings?.(); return native.loadContextOutputConfiguration(...args) })()
      return { then(resolve: (value: unknown) => void, reject: (cause: unknown) => void) {
        void work.then(value => { resolve(value); if (controls.afterSettings) { const hook = controls.afterSettings; controls.afterSettings = undefined; queueMicrotask(hook) } }, reject)
      } }
    },
    createContextOutputService: (...args: Parameters<typeof native.createContextOutputService>) => {
      const owner = native.createContextOutputService(...args), read = owner.readResult, close = owner.close
      owner.readResult = async (...input) => { const page = await read(...input); await controls.page?.(); return page }
      owner.close = async () => { await controls.close?.(); return close() }
      controls.owners.push(owner); return owner
    },
  }
})
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '../src/service.ts'
import { acquireAssemblyResultStore, acquireResultReadStore } from '../src/lifecycle/result-store.ts'

afterEach(() => { controls.settings = undefined; controls.afterSettings = undefined; controls.afterLocation = undefined; controls.page = undefined; controls.close = undefined; controls.owners = [] })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'read-lifetime-')), settings = join(root, 'settings.json'); await writeFile(settings, '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }); await coordinator.create({ sessionId: 's' })
  const options = { workspace: root, coordinator, sessionId: 's', contextOutputSettingsPath: settings }
  const lease = await acquireAssemblyResultStore(options), owner = lease.service!
  const scope = owner.registerResultScope({ operationId: 'original', sessionId: 's', callId: 'c', source: await lease.sourceFor!('s') }, () => true)
  const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('lifetime bytes'))
  const result = await sink.finish('complete'); if (result.kind !== 'committed') throw new Error('Original fixture refused')
  await lease.release()
  const service = createSessionService(options)
  return { options, coordinator, root, service, ref: result.ref, async close() { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}

it.each(['global', 'session'] as const)('joins %s close across held cold settings, page and final release', async mode => {
  for (const phase of ['settings', 'page', 'close'] as const) {
    const f = await fixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
    controls[phase] = async () => { entered.resolve(); await resume.promise }
    let finished = false
    try {
      const read = f.service.readResultPage!('s', { ref: f.ref }); await entered.promise
      const closing = (mode === 'global' ? f.service.close() : f.service.closeSession('s')).then(() => { finished = true })
      await new Promise(resolve => setImmediate(resolve)); expect(finished, phase).toBe(false)
      resume.resolve(); expect(await read, phase).toEqual({ kind: 'unavailable', reason: 'unavailable' }); await closing
      expect(finished).toBe(true)
    } finally { resume.resolve(); controls[phase] = undefined; await f.close() }
  }
})

it.each(['producer', 'reader'] as const)('retries a %s admission when last release retires its awaited original entry', async mode => {
  const f = await fixture(), reader = await acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })
  let releasing: Promise<void> | undefined
  controls[mode === 'producer' ? 'afterSettings' : 'afterLocation'] = () => { releasing = reader.release() }
  const next = await (mode === 'producer' ? acquireAssemblyResultStore(f.options) : acquireResultReadStore({ ...f.options, readCallerAvailable: () => true }))
  try {
    await releasing
    expect(next.service).not.toBe(reader.service)
    expect(await next.sourceFor!('s')).toMatchObject({ readonly: true })
    const scope = next.service!.registerResultScope({ operationId: 'new', sessionId: 's', callId: 'new' }, () => true)
    const sink = await next.service!.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('new owner'))
    expect(await sink.finish('complete')).toMatchObject({ kind: 'committed' })
  } finally { await next.release(); await reader.release(); await f.close() }
})
