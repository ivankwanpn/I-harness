import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContextOutputService, createContextOutputTools, renderContextRecovery } from '../src/index.ts'
import { ContextStore } from '../src/store.ts'
import { DatabaseSync } from 'node:sqlite'
import { createToolRegistry } from '@i-harness/core-tools'
import { createContext } from '../../core-plugin/src/index.ts'

const fixtureBase = resolve(import.meta.dirname, '../../../build/context-output-tests')
const roots: string[] = []
const services: ReturnType<typeof createContextOutputService>[] = []
async function create(options: Record<string, unknown> = {}) {
  await mkdir(fixtureBase, { recursive: true })
  const root = await mkdtemp(resolve(fixtureBase, 'owned-'))
  roots.push(root)
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, ...options })
  services.push(service)
  return { root, service }
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('review regressions', () => {
  it('registers native schemas while disabled and dispatches through the real broker', async () => {
    const { service } = await create({ config: { enabled: false } })
    const registry = createToolRegistry(createContext())
    for (const tool of createContextOutputTools(service)) registry.register(tool)
    const status = await registry.prepare({ name: 'context_output_status', args: {} }, undefined, { sessionId: 'a' })
    expect(await registry.dispatch(status)).toMatchObject({ enabled: false })
    await service.configure({ enabled: true })
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'broker', text: 'needle', complete: true })
    const read = await registry.prepare({ name: 'context_output_read', args: { refId: ref!.id } }, undefined, { sessionId: 'a' })
    expect(await registry.dispatch(read)).toMatchObject({ text: 'needle' })
    await expect(registry.prepare({ name: 'context_output_read', args: { refId: ref!.id, sessionId: 'a' } }, undefined, { sessionId: 'b' })).rejects.toThrow()
    const invalid = await registry.prepare({ name: 'context_output_search', args: { query: '' } }, undefined, { sessionId: 'a' })
    await expect(registry.dispatch(invalid)).rejects.toThrow(/query/i)
    const search = await registry.prepare({ name: 'context_output_search', args: { query: 'needle' } }, undefined, { sessionId: 'a' })
    expect(await registry.dispatch(search)).toMatchObject({ hits: [{ ref: { id: ref!.id } }] })
  })
  it.each([
    { name: 'source authority', text: 'abc', complete: true, source: { sourceId: 'revoked', readonly: true } },
    { name: 'common-prefix original size', text: 'abcd', complete: true },
    { name: 'completeness', text: 'abc', complete: false },
  ])('rejects recaptures with conflicting $name', async ({ name: _name, ...conflict }) => {
    const { service } = await create({ config: { enabled: true, maxCaptureBytes: 3 }, authorize: () => false })
    const first = await service.capture({ sessionId: 'a', callId: '1', label: 'same', text: 'abc', complete: true })
    await expect(service.capture({ sessionId: 'a', callId: '1', label: 'same', ...conflict })).rejects.toThrow(/conflict/i)
    expect((await service.read({ sessionId: 'a' }, { refId: first!.id })).ref).toMatchObject({ complete: true, originalBytes: 3 })
  })

  it('hides a capture from concurrent read/search/status while real post-write validation is held', async () => {
    const { root, service } = await create()
    await service.capture({ sessionId: 'a', callId: 'seed', label: 'seed', text: 'seed', complete: true })
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((r) => { entered = r })
    const held = new Promise<void>((r) => { release = r })
    const original = ContextStore.prototype.diskBytes
    let armed = true
    // Timing gate around the real completed physical measurement. All writes,
    // SQLite transactions, quota checks, queries and rollback remain production.
    ContextStore.prototype.diskBytes = async function(this: ContextStore, directory = this.directory) {
      const bytes = await original.call(this, directory)
      if (armed && directory === this.directory && (await readdir(resolve(directory, 'artifacts'))).length === 2) {
        armed = false; entered(); await held
      }
      return bytes
    }
    const controller = new AbortController()
    const capturing = service.capture({ sessionId: 'a', callId: 'candidate', label: 'candidate', text: 'pending needle', complete: true }, controller.signal)
    const outcome = capturing.then(() => ({ rejected: false }), (error: unknown) => ({ rejected: true, error }))
    try {
      await started
      const workspace = (await readdir(resolve(root, 'context-output')))[0]!
      const artifacts = resolve(root, 'context-output', workspace, 'artifacts')
      const manifests = await Promise.all((await readdir(artifacts)).map((name) => readFile(resolve(artifacts, name), 'utf8').then(JSON.parse)))
      const pendingId = manifests.find((manifest) => manifest.ref.label === 'candidate')!.ref.id as string
      await expect(service.read({ sessionId: 'a' }, { refId: pendingId })).rejects.toThrow()
      expect((await service.search({ sessionId: 'a' }, { query: 'needle' })).hits).toEqual([])
      expect(service.status().results).toBe(1)
      controller.abort()
      release()
      expect(await outcome).toMatchObject({ rejected: true, error: { name: 'AbortError' } })
      expect((await service.search({ sessionId: 'a' }, { query: 'needle' })).hits).toEqual([])
    } finally {
      controller.abort(); release(); await outcome
      ContextStore.prototype.diskBytes = original
    }
  })

  it.each(['read', 'search'] as const)('rejects tiny disk budgets before %s creates any store files', async (operation) => {
    const { root, service } = await create({ config: { enabled: true, maxDiskBytes: 1 } })
    const result = operation === 'read'
      ? service.read({ sessionId: 'a' }, { refId: 'ctx_' + '0'.repeat(64) })
      : service.search({ sessionId: 'a' }, { query: 'needle' })
    await expect(result).rejects.toThrow(/disk|quota/i)
    expect(await readdir(root)).toEqual([])
  })

  it('rejects a newly lowered startup disk budget without rebuilding retained storage', async () => {
    const { root, service } = await create()
    await service.capture({ sessionId: 'a', callId: '1', label: 'retained', text: 'needle', complete: true })
    await service.close()
    const workspace = (await readdir(resolve(root, 'context-output')))[0]!
    const database = resolve(root, 'context-output', workspace, 'index.sqlite')
    const before = await readFile(database)
    const restarted = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true, maxDiskBytes: 1 } })
    services.push(restarted)
    await expect(restarted.search({ sessionId: 'a' }, { query: 'needle' })).rejects.toThrow(/disk|quota/i)
    expect(await readFile(database)).toEqual(before)
  })

  it('uses a persisted SQLite FTS5 candidate index for substring and CJK searches', async () => {
    const { root, service } = await create()
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'fts', text: 'x'.repeat(5000) + '中間錯誤ERROR😀' + 'y'.repeat(5000), complete: true })
    expect((await service.search({ sessionId: 'a' }, { query: 'ERROR' })).hits[0]?.ref.id).toBe(ref!.id)
    expect((await service.search({ sessionId: 'a' }, { query: '中間錯誤' })).hits[0]?.ref.id).toBe(ref!.id)
    const workspace = (await readdir(resolve(root, 'context-output')))[0]!
    const db = new DatabaseSync(resolve(root, 'context-output', workspace, 'index.sqlite'), { readOnly: true })
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE lower(sql) LIKE '%using fts5%' AND name='chunks_fts'").get()).toBeDefined()
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT ref_id FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 64').all('"ERROR"')
      expect(plan.some((row) => String(row.detail).includes('VIRTUAL TABLE INDEX'))).toBe(true)
    } finally { db.close() }
  })

  it('labels bounded short-query fallback and caps a frequent indexed candidate walk', async () => {
    const { service } = await create()
    await service.capture({ sessionId: 'a', callId: '1', label: 'frequent', text: 'needle '.repeat(650000) + '中', complete: true })
    const short = await service.search({ sessionId: 'a' }, { query: '中' })
    expect(short.partial).toBe(true)
    expect(short.reasons).toContain('short-query-fallback')
    const indexed = await service.search({ sessionId: 'a' }, { query: 'needle' })
    expect(indexed.hits).toHaveLength(1)
    expect(indexed.partial).toBe(true)
    expect(indexed.reasons).toContain('candidate-budget')
    const controller = new AbortController()
    const query = service.search({ sessionId: 'a', signal: controller.signal }, { query: 'needle' })
    const rejected = expect(query).rejects.toThrow(/abort/i)
    await new Promise((r) => setImmediate(r))
    controller.abort()
    await rejected
  }, 15000)
})

describe('owned context outputs', () => {
  it('binds same-label outputs to distinct call references and caller ownership', async () => {
    const { service } = await create()
    const one = await service.capture({ sessionId: 'a', callId: '1', label: 'same', text: 'first middle error', complete: true })
    const two = await service.capture({ sessionId: 'a', callId: '2', label: 'same', text: 'second output', complete: true })
    expect(one!.id).not.toBe(two!.id)
    expect((await service.read({ sessionId: 'a' }, { refId: one!.id })).text).toBe('first middle error')
    await expect(service.read({ sessionId: 'b' }, { refId: one!.id })).rejects.toThrow()
  })
  it('recovers immutable artifacts after restart and SQLite index deletion', async () => {
    const { root, service } = await create()
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'restart', text: 'durable needle', complete: true })
    await service.close()
    const workspace = (await readdir(resolve(root, 'context-output')))[0]!
    await rm(resolve(root, 'context-output', workspace, 'index.sqlite'))
    const restarted = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    services.push(restarted)
    expect((await restarted.read({ sessionId: 'a' }, { refId: ref!.id })).text).toBe('durable needle')
    expect((await restarted.search({ sessionId: 'a' }, { query: 'needle' })).hits[0]?.ref.id).toBe(ref!.id)
  })
  it('captures a byte-safe prefix and preserves original size and partial state', async () => {
    const { service } = await create({ config: { enabled: true, maxCaptureBytes: 8 } })
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'quota', text: '中😀文!', complete: true })
    expect(ref).toMatchObject({ bytes: 7, originalBytes: 11, complete: false })
    expect((await service.read({ sessionId: 'a' }, { refId: ref!.id })).text).toBe('中😀')
    const partial = await service.capture({ sessionId: 'a', callId: '2', label: 'source partial', text: 'ok', complete: false })
    expect(partial!.complete).toBe(false)
  })
  it('uses exact UTF-8 cursors without replacement characters or skipped bytes', async () => {
    const { service } = await create()
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'utf8', text: '中😀文Z', complete: true })
    const first = await service.read({ sessionId: 'a' }, { refId: ref!.id, maxBytes: 7 })
    expect(first).toMatchObject({ text: '中😀', offset: 0, nextOffset: 7, eof: false })
    expect(await service.read({ sessionId: 'a' }, { refId: ref!.id, offset: 7, maxBytes: 4 })).toMatchObject({ text: '文Z', nextOffset: null, eof: true })
    await expect(service.read({ sessionId: 'a' }, { refId: ref!.id, offset: 4 })).rejects.toThrow(/boundary/i)
    await expect(service.read({ sessionId: 'a' }, { refId: ref!.id, maxBytes: 2 })).rejects.toThrow(/budget/i)
  })
  it('searches the middle and bounds the complete JSON envelope including metadata', async () => {
    const { service } = await create()
    const text = 'x'.repeat(5000) + '中間ERROR😀' + 'y'.repeat(5000)
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'large metadata ' + 'q'.repeat(200), text, complete: true })
    const result = await service.search({ sessionId: 'a' }, { query: 'ERROR', maxBytes: 900 })
    expect(result.hits[0]?.ref.id).toBe(ref!.id)
    expect(result.hits[0]?.text).toContain('ERROR')
    expect(result.hits[0]?.offset).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(900)
    const tiny = await service.search({ sessionId: 'a' }, { query: 'ERROR', maxBytes: 100 })
    expect(tiny.hits).toEqual([])
    expect(tiny.partial).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(tiny))).toBeLessThanOrEqual(100)
  })
  it('marks partial captured sources and rejects impossible search envelope budgets', async () => {
    const { service } = await create()
    await service.capture({ sessionId: 'a', callId: '1', label: 'partial', text: 'needle', complete: false })
    expect(await service.search({ sessionId: 'a' }, { query: 'needle' })).toMatchObject({ partial: true, reasons: ['incomplete-capture'] })
    await expect(service.search({ sessionId: 'a' }, { query: 'needle', maxBytes: 2 })).rejects.toThrow(/budget/i)
  })
  it('expires outputs on access without trusting a stale index', async () => {
    const { service } = await create({ config: { enabled: true, retentionDays: 0 } })
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'expired', text: 'needle', complete: true })
    await expect(service.read({ sessionId: 'a' }, { refId: ref!.id })).rejects.toThrow()
    expect((await service.search({ sessionId: 'a' }, { query: 'needle' })).hits).toEqual([])
  })
  it('clears independent owners and preserves durably granted fork ownership', async () => {
    const { root, service } = await create()
    const a = await service.capture({ sessionId: 'a', callId: '1', label: 'a', text: 'shared needle', complete: true })
    const b = await service.capture({ sessionId: 'b', callId: '1', label: 'b', text: 'private needle', complete: true })
    await expect(service.grant({ sessionId: 'b' }, [a!.id], 'fork')).rejects.toThrow()
    await service.grant({ sessionId: 'a' }, [a!.id], 'fork')
    await service.clear('a')
    await expect(service.read({ sessionId: 'a' }, { refId: a!.id })).rejects.toThrow()
    expect((await service.read({ sessionId: 'b' }, { refId: b!.id })).text).toBe('private needle')
    await service.close()
    const restarted = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    services.push(restarted)
    expect((await restarted.read({ sessionId: 'fork' }, { refId: a!.id })).text).toBe('shared needle')
    await restarted.clear('fork')
    await expect(restarted.read({ sessionId: 'fork' }, { refId: a!.id })).rejects.toThrow()
    expect(restarted.status().results).toBe(1)
  })
  it('uses explicit host authorization for fork visibility on read and every search hit', async () => {
    const { service } = await create({ authorize: (access: { sessionId: string }, ref: { sessionId: string }) => access.sessionId === 'fork' && ref.sessionId === 'a' })
    const a = await service.capture({ sessionId: 'a', callId: '1', label: 'a', text: 'needle', complete: true })
    await service.capture({ sessionId: 'b', callId: '1', label: 'b', text: 'needle', complete: true })
    expect((await service.read({ sessionId: 'fork' }, { refId: a!.id })).text).toBe('needle')
    expect((await service.search({ sessionId: 'fork' }, { query: 'needle' })).hits.map((hit: { ref: { id: string } }) => hit.ref.id)).toEqual([a!.id])
  })
  it('creates zero files while disabled and preserves data through disable and close', async () => {
    const { root, service } = await create({ config: { enabled: false } })
    expect(service.status().state).toBe('disabled')
    expect(await service.capture({ sessionId: 'a', callId: '1', label: 'off', text: 'off', complete: true })).toBeUndefined()
    await service.clear()
    expect(await readdir(root)).toEqual([])
    await service.configure({ enabled: true })
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'on', text: 'persist', complete: true })
    await service.configure({ enabled: false })
    await expect(service.read({ sessionId: 'a' }, { refId: ref!.id })).rejects.toThrow(/disabled/i)
    await service.configure({ enabled: true })
    expect((await service.read({ sessionId: 'a' }, { refId: ref!.id })).text).toBe('persist')
    expect(service.status()).toMatchObject({ results: 1, retainedBytes: 7, activeJobs: 0 })
  })
  it('waits for held authorization before disable resolves and fences late read completion', async () => {
    let entered!: () => void
    let release!: () => void
    const held = new Promise<boolean>((r) => { release = () => r(true) })
    const started = new Promise<void>((r) => { entered = r })
    const { service } = await create({ authorize: async () => { entered(); return held } })
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'held', text: 'needle', complete: true })
    const reading = service.read({ sessionId: 'fork' }, { refId: ref!.id })
    const readRejected = expect(reading).rejects.toThrow(/abort/i)
    await started
    let stopped = false
    const disabling = service.configure({ enabled: false }).then(() => { stopped = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(stopped).toBe(false)
    expect(service.status()).toMatchObject({ state: 'stopping', activeJobs: 1 })
    release()
    await readRejected
    await disabling
    expect(service.status()).toMatchObject({ state: 'disabled', activeJobs: 0 })
  })
  it('fences an admitted capture queued before close without committing a late artifact', async () => {
    const { root, service } = await create()
    const capturing = service.capture({ sessionId: 'a', callId: '1', label: 'late', text: 'needle', complete: true })
    const rejected = expect(capturing).rejects.toThrow(/abort/i)
    await service.close()
    await rejected
    const restarted = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    services.push(restarted)
    expect((await restarted.search({ sessionId: 'a' }, { query: 'needle' })).hits).toEqual([])
    await expect(service.configure({ enabled: true })).rejects.toThrow(/closed/i)
  })
  it('does not allow invalid identity or a reference to escape owned storage', async () => {
    const { service } = await create()
    await expect(service.capture({ sessionId: '', callId: '1', label: 'bad', text: 'x', complete: true })).rejects.toThrow(/session/i)
    await expect(service.read({ sessionId: 'a' }, { refId: '../../outside' })).rejects.toThrow()
    await expect(service.configure({ maxCaptureBytes: -1 })).rejects.toThrow()
  })
  it('enforces a real disk quota including its SQLite index and immutable files', async () => {
    const { root, service } = await create({ config: { enabled: true, maxDiskBytes: 131072, maxCaptureBytes: 200000 } })
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'disk', text: 'q'.repeat(200000), complete: true })
    if (ref) expect(ref.complete).toBe(false)
    const { stat } = await import('node:fs/promises')
    async function size(path: string): Promise<number> {
      const entries = await readdir(path, { withFileTypes: true })
      const sizes = await Promise.all(entries.map((e) => e.isDirectory() ? size(resolve(path, e.name)) : stat(resolve(path, e.name)).then((s) => s.size)))
      return sizes.reduce((a, b) => a + b, 0)
    }
    expect(await size(root)).toBeLessThanOrEqual(131072)
  })
  it('reports incomplete visible corpus even when a query has no captured match', async () => {
    const { service } = await create()
    await service.capture({ sessionId: 'a', callId: '1', label: 'partial', text: 'captured prefix', complete: false })
    expect(await service.search({ sessionId: 'a' }, { query: 'uncaptured suffix' })).toMatchObject({ hits: [], partial: true, reasons: ['incomplete-capture'] })
    expect(await service.search({ sessionId: 'b' }, { query: 'uncaptured suffix' })).toMatchObject({ hits: [], partial: false, reasons: [] })
  })
  it('restores capture ownership when the original cleared owner recaptures a granted artifact', async () => {
    const { service } = await create()
    const input = { sessionId: 'a', callId: '1', label: 'repeat', text: 'needle', complete: true }
    const ref = await service.capture(input)
    await service.grant({ sessionId: 'a' }, [ref!.id], 'fork')
    await service.clear('a')
    const recaptured = await service.capture(input)
    expect((await service.read({ sessionId: 'a' }, { refId: recaptured!.id })).text).toBe('needle')
    expect((await service.read({ sessionId: 'fork' }, { refId: ref!.id })).text).toBe('needle')
  })
  it('finds bounded literal terms across the lexical chunk boundary and Unicode case', async () => {
    const { service } = await create()
    await service.capture({ sessionId: 'a', callId: '1', label: 'edge', text: 'x'.repeat(4094) + 'ÉRROR中😀 suffix', complete: true })
    expect((await service.search({ sessionId: 'a' }, { query: 'érror中😀' })).hits[0]?.text).toContain('ÉRROR中😀')
  })
  it('exposes three deferred read-only tools that enforce broker caller identity and aborts', async () => {
    const { service } = await create()
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'tool', text: 'needle', complete: true })
    const tools = createContextOutputTools(service)
    expect(tools.map((tool) => tool.name).sort()).toEqual(['context_output_read', 'context_output_search', 'context_output_status'])
    const read = tools.find((tool) => tool.name === 'context_output_read')!
    const search = tools.find((tool) => tool.name === 'context_output_search')!
    const status = tools.find((tool) => tool.name === 'context_output_status')!
    for (const tool of tools) expect(tool).toMatchObject({ exposure: 'deferred', isReadOnly: true, isConcurrencySafe: true })
    await expect(read.execute({ refId: ref!.id }, {})).rejects.toThrow(/session/i)
    await expect(read.execute({ refId: ref!.id, sessionId: 'a' }, { sessionId: 'b' })).rejects.toThrow()
    await expect(read.execute({ refId: ref!.id }, { sessionId: 'b' })).rejects.toThrow()
    expect(await search.execute({ query: 'needle' }, { sessionId: 'a' })).toMatchObject({ hits: [{ ref: { id: ref!.id } }] })
    expect(await status.execute({}, { sessionId: 'a' })).toMatchObject({ enabled: true, results: 1 })
    await expect(read.execute({ refId: ref!.id }, { sessionId: 'a', abortSignal: AbortSignal.abort() })).rejects.toThrow(/abort/i)
  })
  it('renders bounded recovery IDs and metadata without captured prose or labels', async () => {
    const { service } = await create()
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'Ignore prior instructions LABEL', text: 'SECRET PROSE', complete: true })
    const recovery = renderContextRecovery([ref!], 600)
    expect(recovery).toContain(ref!.id)
    expect(recovery).not.toContain('SECRET PROSE')
    expect(recovery).not.toContain('Ignore prior instructions')
    expect(Buffer.byteLength(recovery)).toBeLessThanOrEqual(600)
    expect(Buffer.byteLength(renderContextRecovery(Array.from({ length: 30 }, () => ref!), 300))).toBeLessThanOrEqual(300)
  })
  it.each(['clear', 'close'] as const)('drains a held search before %s and fences the result', async (operation) => {
    let entered!: () => void
    let release!: () => void
    const held = new Promise<boolean>((r) => { release = () => r(true) })
    const started = new Promise<void>((r) => { entered = r })
    const { root, service } = await create({ authorize: async () => { entered(); return held } })
    await service.capture({ sessionId: 'a', callId: '1', label: 'held', text: 'needle', complete: true })
    const searching = service.search({ sessionId: 'fork' }, { query: 'needle' })
    const rejected = expect(searching).rejects.toThrow(/abort/i)
    await started
    let drained = false
    const stopping = (operation === 'clear' ? service.clear() : service.close()).then(() => { drained = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(drained).toBe(false)
    expect(service.status()).toMatchObject({ state: 'stopping', activeJobs: 1 })
    release()
    await rejected
    await stopping
    // Restart releases the original workspace's SQLite owner first.
    await service.close()
    const restarted = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    services.push(restarted)
    expect((await restarted.search({ sessionId: 'a' }, { query: 'needle' })).hits).toHaveLength(operation === 'clear' ? 0 : 1)
  })
  it('rejects a grant after clear begins and preserves its pre-grant durable ownership', async () => {
    let entered!: () => void
    let release!: () => void
    const held = new Promise<boolean>((r) => { release = () => r(true) })
    const started = new Promise<void>((r) => { entered = r })
    const { service } = await create({ authorize: async (access: { sessionId: string }) => {
      if (access.sessionId !== 'host-fork') return false
      entered(); return held
    } })
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'grant', text: 'needle', complete: true })
    const granting = service.grant({ sessionId: 'host-fork' }, [ref!.id], 'target')
    const rejected = expect(granting).rejects.toThrow(/abort/i)
    await started
    const clearing = service.clear('host-fork')
    release()
    await rejected
    await clearing
    await expect(service.read({ sessionId: 'target' }, { refId: ref!.id })).rejects.toThrow()
    expect((await service.read({ sessionId: 'a' }, { refId: ref!.id })).text).toBe('needle')
  })
  it('drains a capture during real owned file I/O before disable resolves', async () => {
    const { root, service } = await create()
    await service.capture({ sessionId: 'a', callId: 'seed', label: 'seed', text: 'seed', complete: true })
    const workspace = (await readdir(resolve(root, 'context-output')))[0]!
    const blobs = resolve(root, 'context-output', workspace, 'blobs')
    const capturing = service.capture({ sessionId: 'a', callId: 'large', label: 'large', text: 'x'.repeat(8 * 1024 * 1024), complete: true })
    let ended = false
    const rejection = expect(capturing).rejects.toThrow(/abort/i)
    capturing.finally(() => { ended = true }).catch(() => {})
    // Observe the real second blob while its async write/manifest publication
    // is pending. No replacement store or artificial production hook is used.
    while ((await readdir(blobs)).length < 2 && !ended) await new Promise((r) => setImmediate(r))
    expect(ended).toBe(false)
    await service.configure({ enabled: false })
    await rejection
    expect(service.status()).toMatchObject({ state: 'disabled', activeJobs: 0, results: 1 })
    expect(await readdir(blobs)).toHaveLength(1)
  })
  it('rolls back an interrupted batch grant after real ownership I/O begins', async () => {
    const { root, service } = await create()
    const ids: string[] = []
    for (let i = 0; i < 8; i++) {
      const ref = await service.capture({ sessionId: 'a', callId: String(i), label: 'batch', text: 'needle', complete: true })
      ids.push(ref!.id)
    }
    const workspace = (await readdir(resolve(root, 'context-output')))[0]!
    const ledger = resolve(root, 'context-output', workspace, 'owners', ids[0]! + '.json')
    const controller = new AbortController()
    const granting = service.grant({ sessionId: 'a', signal: controller.signal }, ids, 'target')
    const rejected = expect(granting).rejects.toThrow(/abort/i)
    let ended = false
    granting.finally(() => { ended = true }).catch(() => {})
    while (!JSON.parse(await readFile(ledger, 'utf8')).includes('target') && !ended) await new Promise((r) => setImmediate(r))
    expect(ended).toBe(false)
    controller.abort()
    await rejected
    await service.close()
    const restarted = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    services.push(restarted)
    for (const id of ids) await expect(restarted.read({ sessionId: 'target' }, { refId: id })).rejects.toThrow()
    expect((await restarted.read({ sessionId: 'a' }, { refId: ids[0]! })).text).toBe('needle')
  })
  it('rebuilds a corrupt derived SQLite index from intact immutable artifacts', async () => {
    const { root, service } = await create()
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'repair', text: 'durable needle', complete: true })
    await service.close()
    const workspace = (await readdir(resolve(root, 'context-output')))[0]!
    await writeFile(resolve(root, 'context-output', workspace, 'index.sqlite'), 'corrupt derived index')
    const restarted = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    services.push(restarted)
    expect((await restarted.search({ sessionId: 'a' }, { query: 'needle' })).hits[0]?.ref.id).toBe(ref!.id)
  })
  it('preserves source authority metadata in references across restart', async () => {
    const { root, service } = await create()
    const source = { sourceId: 'admitted-source', path: 'readonly/log.txt', revision: 'source-rev', readonly: true }
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'source', text: 'needle', complete: true, source })
    expect(ref).toMatchObject({ source })
    await service.close()
    const restarted = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true },
      authorize: (_access, restored) => (restored as { source?: { sourceId: string } }).source?.sourceId === 'admitted-source' })
    services.push(restarted)
    expect((await restarted.read({ sessionId: 'fork' }, { refId: ref!.id })).ref).toMatchObject({ source })
  })
  it('rechecks host source authority for an existing owner after source revocation', async () => {
    let admitted = true
    const { service } = await create({ authorize: () => admitted })
    const ref = await service.capture({ sessionId: 'a', callId: '1', label: 'source', text: 'needle', complete: true,
      source: { sourceId: 'source', readonly: true } })
    expect((await service.read({ sessionId: 'a' }, { refId: ref!.id })).text).toBe('needle')
    admitted = false
    await expect(service.read({ sessionId: 'a' }, { refId: ref!.id })).rejects.toThrow()
    expect((await service.search({ sessionId: 'a' }, { query: 'needle' })).hits).toEqual([])
  })
})
