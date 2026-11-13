import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '../src/index.ts'
import { acquireAssemblyResultStore } from '../src/lifecycle/result-store.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'result-reader-'))
  const settings = join(root, 'settings.json'); await writeFile(settings, '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 's' }); await coordinator.create({ sessionId: 'other' }); await coordinator.flush('s')
  const lease = await acquireAssemblyResultStore({ workspace: root, coordinator, sessionId: 's', contextOutputSettingsPath: settings })
  const owner = lease.service!, source = await lease.sourceFor!('s')
  const scope = owner.registerResultScope({ operationId: 'original', sessionId: 's', callId: 'c', source }, () => true)
  const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('original retained 🙂'))
  const saved = await sink.finish('source-limited'); if (saved.kind !== 'committed') throw new Error('Original commit refused')
  return { root, settings, coordinator, lease, owner, ref: saved.ref }
}

it('offers a cold durable reader with original pins and no execution or session mutation', async () => {
  const f = await fixture(); await f.lease.release(); await f.coordinator.close()
  const coordinator = createSessionCoordinator(createJsonlBackend(f.root), { lock: { enabled: true } })
  const model = vi.fn(), projects = vi.fn(), staticScope = vi.fn(() => { throw new Error('Execution-only static scope must not be read') })
  const service = createSessionService({ workspace: f.root, coordinator, contextOutputSettingsPath: f.settings, modelBindingFor: model, projectContextFor: projects, projectContext: staticScope })
  const assembled = vi.fn(), off = service.onAssembly(assembled)
  try {
    const before = await readFile(join(f.root, 's.jsonl'))
    const retainedBefore = await readdir(join(f.root, 'native-context'), { recursive: true })
    expect(service.readResultPage).toEqual(expect.any(Function))
    expect(await service.readResultPage!('s', { ref: f.ref })).toMatchObject({ ref: f.ref, eof: true, data: { text: 'original retained 🙂' } })
    expect(await service.readResultPage!('other', { ref: f.ref })).toEqual({ kind: 'unavailable', reason: 'unauthorized' })
    await coordinator.putDocument('desktop-session-project-' + createHash('sha256').update('s').digest('hex'), { version: 1, projectId: 'p' })
    expect(await service.readResultPage!('s', { ref: f.ref })).toMatchObject({ kind: 'unavailable' })
    expect(await readFile(join(f.root, 's.jsonl'))).toEqual(before)
    expect(await readdir(join(f.root, 'native-context'), { recursive: true })).toEqual(retainedBefore)
    expect(retainedBefore.some(path => /index\.sqlite/.test(path))).toBe(false)
    expect(model).not.toHaveBeenCalled(); expect(projects).not.toHaveBeenCalled(); expect(staticScope).not.toHaveBeenCalled(); expect(assembled).not.toHaveBeenCalled()
  } finally { off(); await service.close(); await coordinator.close(); await rm(f.root, { recursive: true, force: true }) }
})

it('does not advertise a page reader without a supplied owner or durable coordinator', async () => {
  const service = createSessionService({ workspace: process.cwd() })
  try { expect(service.readResultPage).toBeUndefined() } finally { await service.close() }
})

it.each(['global', 'session'] as const)('joins a complete %s read including acquisition and discards its revoked page', async mode => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const profile = f.coordinator.profile.bind(f.coordinator)
  let held = false
  const heldProfile = vi.spyOn(f.coordinator, 'profile').mockImplementation(async id => {
    if (!held) { held = true; entered.resolve(); await resume.promise }
    return profile(id)
  })
  const service = createSessionService({ workspace: f.root, coordinator: f.coordinator, contextOutputSettingsPath: f.settings })
  let read: ReturnType<NonNullable<typeof service.readResultPage>> | undefined
  let closing: Promise<void> | undefined
  let primary: { cause: unknown } | undefined
  try {
    expect(service.readResultPage).toEqual(expect.any(Function))
    read = service.readResultPage!('s', { ref: f.ref })
    void read.catch(() => {})
    await Promise.race([entered.promise, read.then(result => { throw new Error('Original page read finished before profile acquisition', { cause: result }) })])
    let closed = false
    closing = (mode === 'global' ? service.close() : service.closeSession('s')).then(() => { closed = true })
    void closing.catch(() => {})
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false)
    resume.resolve(); expect(await read).toEqual({ kind: 'unavailable', reason: 'unavailable' }); await closing
    if (mode === 'session') expect(await service.readResultPage!('s', { ref: f.ref })).toMatchObject({ eof: true })
  } catch (cause) { primary = { cause } }
  finally {
    resume.resolve()
    const joined = await Promise.allSettled([read, closing])
    const failures = joined.flatMap(result => result.status === 'rejected' && (!primary || result.reason !== primary.cause) ? [result.reason] : [])
    for (const close of [() => service.close(), () => f.lease.release(), () => f.coordinator.close()]) {
      try { await close() } catch (cause) { failures.push(cause) }
    }
    heldProfile.mockRestore()
    const target = resolve(f.root)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('result-reader-')) failures.push(Error('Unexpected owned reader fixture root'))
    else if (!primary && !failures.length) try { await rm(target, { recursive: true, force: true }) } catch (cause) { failures.push(cause) }
    if (primary || failures.length) console.error('Preserved failed reader fixture:', target)
    if (primary && !failures.length) throw primary.cause
    if (failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original page read and cleanup failed', { cause: primary?.cause })
  }
})

it('borrows the supplied original owner without configuring or closing it', async () => {
  const f = await fixture(), close = vi.spyOn(f.owner, 'close'), configure = vi.spyOn(f.owner, 'configure')
  const service = createSessionService({ workspace: f.root, coordinator: f.coordinator, contextOutput: f.owner })
  try {
    expect(service.readResultPage).toEqual(expect.any(Function))
    expect(await service.readResultPage!('s', { ref: f.ref })).toMatchObject({ eof: true })
    await service.close(); expect(close).not.toHaveBeenCalled(); expect(configure).not.toHaveBeenCalled()
  } finally { await service.close(); await f.lease.release(); await f.coordinator.close(); await rm(f.root, { recursive: true, force: true }) }
})
