import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createSession, createNondurableFactOwner, decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgent } from '@i-harness/core-agent'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createChildInstructionHost } from '../src/context/instructions/child-host.ts'
import { rmWorkspaceSync } from './helpers.ts'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const seams = vi.hoisted(() => ({ sectionFault: false, closeFault: false, fault: undefined as unknown, gate: undefined as Promise<void> | undefined,
  publicationFault: false, publicationGate: undefined as Promise<void> | undefined, publicationCalls: 0,
  failRuntimeIndex: undefined as number | undefined,
  runtimes: [] as { attempts: number; closed: boolean }[], managers: [] as { attempts: number; closed: boolean }[],
  originalClose: undefined as (() => void) | undefined, succeeded: 0, beforeSucceeded: undefined as (() => void) | undefined }))
vi.mock('@i-harness/runtime-context', async original => {
  const api = await original<typeof import('@i-harness/runtime-context')>()
  return { ...api, createRuntimeContext(...args: Parameters<typeof api.createRuntimeContext>) {
    const runtime = api.createRuntimeContext(...args), entry = { attempts: 0, closed: false }, index = seams.runtimes.length; seams.runtimes.push(entry)
    return { ...runtime, async settleOriginals() {
      seams.publicationCalls++; await seams.publicationGate
      if (seams.publicationFault) throw seams.fault
      await runtime.settleOriginals()
    }, registerSection(...section: Parameters<typeof runtime.registerSection>) {
      const result = runtime.registerSection(...section); if (seams.sectionFault) throw seams.fault; return result
    }, async close() { entry.attempts++; seams.originalClose?.(); await seams.gate; if (seams.closeFault && (seams.failRuntimeIndex === undefined || seams.failRuntimeIndex === index)) throw seams.fault; await runtime.close(); entry.closed = true } }
  } }
})
vi.mock('../src/context/instructions/manager.ts', async original => {
  const api = await original<typeof import('../src/context/instructions/manager.ts')>()
  return { ...api, createMainInstructionManager(...args: Parameters<typeof api.createMainInstructionManager>) {
    const manager = api.createMainInstructionManager(...args), entry = { attempts: 0, closed: false }; seams.managers.push(entry)
    return { ...manager, succeeded(...handoff: Parameters<typeof manager.succeeded>) { seams.beforeSucceeded?.(); manager.succeeded(...handoff); seams.succeeded++ },
      async close() { entry.attempts++; await manager.close(); entry.closed = true } }
  } }
})
afterEach(() => { seams.publicationFault = false; seams.publicationGate = undefined; seams.publicationCalls = 0; seams.sectionFault = false; seams.closeFault = false; seams.failRuntimeIndex = undefined; seams.fault = undefined; seams.gate = undefined; seams.runtimes = []; seams.managers = []; seams.originalClose = undefined; seams.succeeded = 0; seams.beforeSucceeded = undefined })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'ic-l-')), childDir = join(cwd, 'nested'); await mkdir(childDir)
  await writeFile(join(cwd, 'AGENTS.md'), 'LIFETIME_ROOT'); await writeFile(join(childDir, 'AGENTS.md'), 'LIFETIME_NESTED')
  const environment = createProjectInstructionEnvironment(), session = createSession(), factOwner = createNondurableFactOwner(session)
  const options = { cwd, environment, available: () => true, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }) }
  const manager = createMainInstructionManager({ ...options, publish: async () => {} })
  const host = createChildInstructionHost({ ...options, root: { session, factOwner, manager } })
  const child = createSession(), owner = createNondurableFactOwner(child), input = { session: child, factOwner: owner, lifetime: { available: () => true } }
  return { ...options, manager, host, session, child, owner, input, childDir, async close() {
    seams.sectionFault = false; seams.closeFault = false; seams.gate = undefined; seams.originalClose = undefined
    await host.close(); await manager.close(); await environment.close(); rmWorkspaceSync(cwd)
  } }
}

it.each([undefined, null, false, 0, ''])('shares original nonretiring publication failure %s with concurrent lease close before a later explicit retry', async failure => {
  const f = await fixture(), lease = f.host.create(f.input), gate = Promise.withResolvers<void>()
  seams.publicationFault = true; seams.fault = failure; seams.publicationGate = gate.promise
  try {
    const publication = lease.settleOriginals(), alias = lease.settleOriginals(), closing = lease.close()
    expect(publication).toBe(alias)
    await turn(); expect(seams.publicationCalls).toBe(1)
    expect(seams.runtimes[0]!.attempts).toBe(0)
    gate.resolve()
    for (const attempt of [publication, alias, closing]) await expect(attempt).rejects.toBe(failure)
    expect(seams.runtimes[0]!.attempts).toBe(0); expect(seams.managers[0]!.attempts).toBe(0)
    seams.publicationFault = false
    await lease.settleOriginals(); await lease.close()
    expect(seams.publicationCalls).toBe(2); expect(seams.runtimes[0]!.attempts).toBe(1)
    expect(seams.managers[1]!.attempts).toBe(1)
  } finally { gate.resolve(); seams.publicationFault = false; await f.close() }
})

it('host close joins original root and child mappings after synchronous retirement without closing borrowed owners', async () => {
  const f = await fixture(), lease = f.host.create(f.input), original = fs.realpath
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let calls = 0
  const mapping = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
    if (String(args[0]) === f.childDir) { if (++calls === 2) entered.resolve(); await gate.promise }; return original(...args)
  })
  const rootClose = vi.spyOn(f.manager, 'close'), outerClose = vi.spyOn(f.environment, 'close')
  try {
    const a = f.host.observe({ path: f.childDir, kind: 'directory' }, { session: f.session })
    const b = f.host.observe({ path: f.childDir, kind: 'directory' }, { session: f.child })
    await entered.promise
    // Do not wait for this manager mapping to reach a runtime render.
    await lease.settleOriginals()
    let closed = false; const closing = f.host.close().then(() => { closed = true })
    await turn(); expect(closed).toBe(false); expect(seams.runtimes[0]!.attempts).toBe(0)
    expect(lease.requestContext.capture()).toBeUndefined(); expect(lease.requestContext.current(undefined)).toBe(false)
    await expect(lease.requestContext.reconcile()).rejects.toMatchObject({ code: 'CONTEXT_INPUT_STALE' })
    expect(() => lease.requestContext.promotedHumanRequest()).toThrow()
    gate.resolve()
    expect(await a).toEqual({ status: 'unavailable', reason: 'mapping-unavailable' }); expect(await b).toEqual({ status: 'unavailable', reason: 'mapping-unavailable' })
    await closing
    expect(rootClose).not.toHaveBeenCalled(); expect(outerClose).not.toHaveBeenCalled()
  } finally { gate.resolve(); mapping.mockRestore(); await f.close() }
})

it.each([undefined, null])('failed constructor retains obtained originals, observes cleanup fault %s, and allows acknowledged retry without host shutdown', async fault => {
  const f = await fixture(), gate = Promise.withResolvers<void>()
  try {
    seams.sectionFault = true; seams.closeFault = true; seams.fault = fault; seams.gate = gate.promise
    let threw = false; try { f.host.create(f.input) } catch (error) { threw = true; expect(error).toBe(fault) }; expect(threw).toBe(true)
    seams.sectionFault = false
    expect(() => f.host.create(f.input)).toThrow()
    gate.resolve(); await turn()
    expect(seams.runtimes[0]).toMatchObject({ attempts: 1, closed: false }); expect(seams.managers[1]!.attempts).toBe(0)
    expect(() => f.host.create({ ...f.input, factOwner: createNondurableFactOwner(f.child) })).toThrow()
    await turn(); expect(seams.runtimes[0]!.attempts).toBe(1)
    seams.closeFault = false; seams.gate = undefined
    // CF04: same exact original may request one deferred cleanup retry, but
    // replacement remains refused until that original actually acknowledges.
    expect(() => f.host.create(f.input)).toThrow()
    expect(() => f.host.create(f.input)).toThrow()
    await turn()
    expect(seams.runtimes[0]).toMatchObject({ attempts: 2, closed: true }); expect(seams.managers[1]!.attempts).toBe(1)
    const replacement = f.host.create(f.input); await replacement.close()
    await expect(f.host.close()).resolves.toBeUndefined()
    expect(seams.runtimes[0]!.attempts).toBe(2)
  } finally { gate.resolve(); await f.close() }
})

it('a failed nondurable input alias cannot substitute another owner to trigger the original CF04 cleanup', async () => {
  const f = await fixture(), originalInput = { ...f.input }, input = { ...f.input }
  const replacementOwner = createNondurableFactOwner(f.child)
  try {
    seams.sectionFault = true; seams.closeFault = true; seams.fault = Error('retained original construction cleanup')
    expect(() => f.host.create(input)).toThrow('retained original construction cleanup')
    seams.sectionFault = false; await turn()
    expect(seams.runtimes[0]).toMatchObject({ attempts: 1, closed: false })
    input.factOwner = replacementOwner
    expect(() => f.host.create(input)).toThrow()
    await turn()
    expect(seams.runtimes[0]).toMatchObject({ attempts: 1, closed: false })
    expect(seams.runtimes).toHaveLength(1); expect(seams.managers[1]!.attempts).toBe(0)
    seams.closeFault = false
    expect(() => f.host.create(originalInput)).toThrow()
    await turn(); expect(seams.runtimes[0]).toMatchObject({ attempts: 2, closed: true })
    const replacement = f.host.create(originalInput); await replacement.close()
  } finally { seams.closeFault = false; await f.close() }
})

it('captured constructor cleanup remains joined when successful completion removes its reserved slot', async () => {
  const f = await fixture(), gate = Promise.withResolvers<void>()
  try {
    seams.sectionFault = true; seams.fault = Error('delivered setup fault'); seams.gate = gate.promise
    expect(() => f.host.create(f.input)).toThrow('delivered setup fault'); seams.sectionFault = false
    await turn(); let finished = false
    const closing = f.host.close().then(() => { finished = true })
    await turn(); expect(finished).toBe(false)
    gate.resolve(); await closing
    expect(seams.runtimes[0]).toMatchObject({ attempts: 1, closed: true }); expect(seams.managers[1]!.attempts).toBe(1)
    await expect(f.host.close()).resolves.toBeUndefined()
  } finally { gate.resolve(); await f.close() }
})

it('close from an original cleanup invocation rejects locally while external callers join and successful phases never replay', async () => {
  const f = await fixture(), lease = f.host.create(f.input), gate = Promise.withResolvers<void>()
  let local: Promise<void> | undefined, localHost: Promise<void> | undefined
  try {
    seams.gate = gate.promise; seams.originalClose = () => { local = lease.close(); localHost = f.host.close() }
    const a = lease.close(), b = lease.requestContext.close()
    await turn(); await expect(local).rejects.toThrow(/reentrant/i); await expect(localHost).rejects.toThrow(/reentrant/i)
    expect(seams.runtimes[0]!.attempts).toBe(1)
    gate.resolve(); await Promise.all([a, b]); seams.originalClose = undefined
    await lease.close(); await f.host.close(); expect(seams.runtimes[0]!.attempts).toBe(1)
  } finally { gate.resolve(); await f.close() }
})

it('close reentered after an original reconcile await rejects locally instead of joining that same pending reconcile', async () => {
  const f = await fixture(), lease = f.host.create(f.input), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const create = f.environment.host.create.bind(f.environment.host)
  let status = 'pending', local: Promise<void> | undefined, reconciliation: Promise<void> | undefined
  f.environment.host.create = scope => { const source = create(scope); return { ...source, async prepare(targets) {
    await Promise.resolve()
    local = lease.close(); void local.then(() => { status = 'fulfilled' }, () => { status = 'rejected' })
    entered.resolve(); await gate.promise
    return source.prepare(targets)
  } } }
  try {
    reconciliation = lease.requestContext.reconcile(); void reconciliation.catch(() => {})
    await entered.promise; await turn()
    expect(status).toBe('rejected')
    await expect(local).rejects.toThrow(/reentrant/i)
    gate.resolve(); await expect(reconciliation).rejects.toThrow()
    await expect(lease.close()).resolves.toBeUndefined()
  } finally { gate.resolve(); await reconciliation?.catch(() => {}); await f.close() }
})

it('a completed original invocation does not poison a later scheduled cleanup in its async context', async () => {
  const f = await fixture(), observe = f.manager.observe.bind(f.manager), later = Promise.withResolvers<void>()
  f.manager.observe = async target => {
    const result = await observe(target)
    setImmediate(() => { void f.host.close().then(later.resolve, later.reject) })
    return result
  }
  try {
    expect(await f.host.observe({ path: f.childDir, kind: 'directory' }, { session: f.session })).toEqual({ status: 'queued' })
    await expect(later.promise).resolves.toBeUndefined()
  } finally { await f.close() }
})

it('a reported reconciliation failure is historical and never poisons a later successful cleanup or sibling', async () => {
  const f = await fixture(), lease = f.host.create(f.input), sibling = createSession()
  const second = f.host.create({ session: sibling, factOwner: createNondurableFactOwner(sibling), lifetime: { available: () => true } })
  const original = f.environment.host.create.bind(f.environment.host); let fail = true
  f.environment.host.create = scope => { const source = original(scope); return { ...source, async prepare(targets) { if (fail) throw undefined; return source.prepare(targets) } } }
  try {
    await expect(lease.requestContext.reconcile()).rejects.toBeUndefined(); fail = false
    await second.requestContext.reconcile()
    await expect(f.host.close()).resolves.toBeUndefined()
    expect(seams.runtimes.every(runtime => runtime.closed)).toBe(true)
    await expect(f.host.close()).resolves.toBeUndefined()
  } finally { fail = false; await f.close() }
})

it('a failed child runtime preserves its manager dependency while host close still settles an independent sibling', async () => {
  const f = await fixture(), first = f.host.create(f.input), sibling = createSession()
  const second = f.host.create({ session: sibling, factOwner: createNondurableFactOwner(sibling), lifetime: { available: () => true } })
  try {
    await Promise.all([first.requestContext.reconcile(), second.requestContext.reconcile()])
    seams.closeFault = true; seams.failRuntimeIndex = 0; seams.fault = undefined
    const result = await f.host.close().then(() => undefined, error => error)
    expect(result).toBeInstanceOf(AggregateError); expect(result.errors).toContain(undefined)
    expect(seams.runtimes[0]).toMatchObject({ attempts: 1, closed: false }); expect(seams.managers[1]!.attempts).toBe(0)
    expect(seams.runtimes[1]).toMatchObject({ attempts: 1, closed: true }); expect(seams.managers[2]).toMatchObject({ attempts: 1, closed: true })
    seams.closeFault = false; await f.host.close()
    expect(seams.runtimes[0]).toMatchObject({ attempts: 2, closed: true }); expect(seams.runtimes[1]!.attempts).toBe(1)
    await expect(f.host.close()).resolves.toBeUndefined()
  } finally { seams.closeFault = false; await f.close() }
})

it('dynamic lifetime and request aborts fence new preparation without turning ordinary turn interruption into permanent retirement', async () => {
  const f = await fixture(); let live = true
  const lease = f.host.create({ ...f.input, lifetime: { available: () => live } })
  try {
    const interrupted = new AbortController(); interrupted.abort(Error('one original turn interrupted'))
    await expect(lease.requestContext.reconcile(interrupted.signal)).rejects.toThrow('one original turn interrupted')
    await lease.requestContext.reconcile(); const evidence = lease.requestContext.capture()!
    live = false
    expect(lease.requestContext.capture()).toBeUndefined(); expect(lease.requestContext.current(evidence)).toBe(false)
    await expect(lease.requestContext.reconcile()).rejects.toMatchObject({ code: 'CONTEXT_INPUT_STALE' })
    expect(await f.host.observe({ path: f.childDir, kind: 'directory' }, { session: f.child })).toEqual({ status: 'unavailable', reason: 'mapping-unavailable' })
    live = true; await lease.requestContext.reconcile(); expect(lease.requestContext.current(lease.requestContext.capture())).toBe(true)
    await lease.close()
  } finally { live = true; await f.close() }
})

it('retirement preserves issued retain, physical accepted succeeded and original pin release while refusing new human selection', async () => {
  const f = await fixture(), lease = f.host.create(f.input), ctx = createContext()
  const requests: string[] = [], server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'physically accepted' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture loopback')
  let retained = 0
  try {
    await f.host.observe({ path: f.childDir, kind: 'directory' }, { session: f.child })
    seams.beforeSucceeded = () => {
      if (seams.succeeded === 1) {
        const evidence = lease.requestContext.capture()!
        lease.retire(); const pin = lease.requestContext.retain(evidence); retained++; void pin.release()
      }
    }
    const agent = createAgent(ctx, { session: f.child, factOwner: f.owner, tools: createToolRegistry(ctx), requestContext: lease.requestContext,
      model: createOpenAICompatibleClient({ model: 'fixture', apiKey: 'fixture-loopback', baseUrl: `http://127.0.0.1:${address.port}` }), systemPrompt: 'lifecycle library request', budget: { contextWindow: 100000 } })
    await agent.followup('issue under original child context')
    expect(seams.succeeded).toBe(1)
    const next = join(f.cwd, 'next'); await mkdir(next); await writeFile(join(next, 'AGENTS.md'), 'LIFETIME_NEXT')
    await f.host.observe({ path: next, kind: 'directory' }, { session: f.child })
    await agent.followup('next original wave after actual accepted exchange')
    const current = f.child.events.findLast(event => event.type === 'runtime/context')
    expect(JSON.stringify(current)).toContain('LIFETIME_NEXT'); expect(JSON.stringify(current)).not.toContain('LIFETIME_NESTED')
    expect(seams.succeeded).toBe(2); expect(retained).toBe(1); expect(requests).toHaveLength(2)
    expect(requests.every(body => body.includes('LIFETIME_ROOT'))).toBe(true)
    expect(() => lease.requestContext.promotedHumanRequest()).toThrow()
    await lease.close()
  } finally {
    seams.beforeSucceeded = undefined; await f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('an original failed pin release keeps the exact manager resource and does not replay completed runtime cleanup', async () => {
  const f = await fixture(), lease = f.host.create(f.input), original = f.environment.host.create.bind(f.environment.host)
  let first = true, allow = false, attempts = 0
  f.environment.host.create = scope => {
    const source = original(scope), isFirst = first; first = false
    return { ...source, async close() { if (isFirst) { attempts++; if (!allow) throw Error('original pin release fault') }; await source.close() } }
  }
  try {
    await lease.requestContext.reconcile(); const evidence = lease.requestContext.capture()!, pin = lease.requestContext.retain(evidence)
    await f.host.observe({ path: f.childDir, kind: 'directory' }, { session: f.child }); await lease.requestContext.reconcile()
    lease.retire(); await expect(pin.release()).rejects.toThrow('original pin release fault')
    await expect(lease.close()).rejects.toThrow()
    expect(seams.runtimes[0]!.attempts).toBe(1); expect(attempts).toBeGreaterThanOrEqual(2)
    allow = true; await pin.release(); await lease.close()
    expect(seams.runtimes[0]!.attempts).toBe(1)
    await expect(lease.close()).resolves.toBeUndefined()
  } finally { allow = true; await f.close() }
})

it('unknown managed publication retains its original capture/pin and runtime-before-manager dependency until acknowledgment', async () => {
  const f = await fixture(), backend = createJsonlBackend(join(f.cwd, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  let key: BatchKey | undefined, acknowledged = false, publications = 0
  backend.appendOwnedBatch = async (...args) => {
    const result = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'runtime/context')) { key = args[3].key; publications++; return { kind: 'unknown', key } }
    return result
  }
  backend.reconcileOwnedBatch = (...args) => !acknowledged && key?.batchId === args[3].key.batchId ? Promise.resolve({ kind: 'unknown', key: args[3].key }) : reconcile(...args)
  try {
    const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
    const lease = f.host.create({ session: document.view, factOwner: document, lifetime: { available: () => true } })
    await expect(lease.requestContext.reconcile()).rejects.toThrow()
    const before = document.view.events.length
    await expect(lease.close()).rejects.toThrow()
    expect(seams.managers[1]!.attempts).toBe(0); expect(seams.runtimes[0]!.closed).toBe(false)
    acknowledged = true; await lease.close()
    expect(seams.managers[1]).toMatchObject({ attempts: 1, closed: true }); expect(publications).toBe(1)
    expect(document.view.events.length).toBe(before + 1)
    expect(document.view.events.at(-1)).toMatchObject({ type: 'runtime/context' })
    await lease.close(); expect(seams.runtimes[0]!.attempts).toBe(2)
    await document.close()
  } finally { acknowledged = true; await f.close(); await coordinator.close() }
})
