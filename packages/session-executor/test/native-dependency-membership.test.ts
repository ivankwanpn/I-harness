import { expect, it, vi } from 'vitest'
const cuts = vi.hoisted(() => ({ afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const native = await original<typeof import('node:fs/promises')>()
  return { ...native,
    rename: async (...args: Parameters<typeof native.rename>) => { const result = await native.rename(...args); await cuts.afterRename?.(String(args[0]), String(args[1])); return result },
  }
})
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fixture, rawBytes } from './native-dependency-fixture.ts'
import { currentToolResultProducer, toolResultDependencies } from './native-dependency-fixture.ts'
import type { ResultDependency } from '@i-harness/core-session'
const { physicalBytes } = await import('../../context-output/src/artifact/quota.ts')
const { committedFactSeqs } = await import('@i-harness/core-session')

it('checks the actual catalog captured-source policy as well as its member source and closed visibility', async () => {
  const f = await fixture('catalog-current-policy')
  let dependency: ResultDependency | undefined
  await f.mount(async () => {
    const native = await f.exec.run({ argv: [process.execPath, '-e', "process.stdout.write('actual-source-A')"] })
    expect(native.exitCode).toBe(0)
    const registered = await toolResultDependencies(currentToolResultProducer()!)[0]!.settle()
    if (registered.kind !== 'ready') throw new Error('Original native source A did not settle')
    dependency = registered.dependency
    return { nativeExit: native.exitCode }
  })
  try {
    await f.assembly.agent.run('capture actual native source A')
    if (dependency?.retention.kind !== 'artifact') throw new Error('Original actual frame A unavailable')
    const currentSource = await f.lease.sourceFor!(f.id)
    const scope = f.service.registerResultDependencyScope({ operationId: 'original-policy-B-catalog', sessionId: f.id, callId: 'policy-B', source: { ...currentSource, sourceId: 'captured-source-B' } }, () => true, [dependency])
    const sink = await f.service.beginResult(scope, 'json-utf8-v1')
    await sink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries: [dependency] })))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Original catalog B did not commit')
    expect(await f.service.settleResultDependencyMembership(scope, saved.ref)).toBe('ready')
    // Original storage/current-policy seam: publish the catalog as an actual
    // closed managed delivery fact. This is not a claim of an Agent source
    // switching schedule or permission inferred from serialized catalog data.
    const document = await f.coordinator.openManagedDocument(f.id), action = document.beginAction(), source = action.registerSettlementSource(async () => {})
    committedFactSeqs(await source.delivery.record({ type: 'subagent/end', version: 1, taskId: 'policy-boundary', outcome: 'completed', resultRevision: 'policy-B-revision', envelope: {
      version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, media: [], preview: '', retention: { kind: 'inline', value: 'policy', encodedBytes: 8 }, dependencies: { kind: 'artifact-set', ref: saved.ref, count: 1 },
    } }))
    await source.close(); action.finish()
    await expect(f.service.readResult({ sessionId: f.id }, { ref: saved.ref })).rejects.toThrow(/unauthorized/)
    await writeFile(resolve(f.root, 'catalog-policy-receipt.json'), JSON.stringify({ currentSource, catalogCapturedSource: 'captured-source-B', frame: dependency.retention.ref, catalog: saved.ref, scope: scope.operationId, originalRegisteredSourceId: dependency.sourceId, boundary: 'original automatic-store source policy plus actual closed managed delivery fact' }, null, 2))
    await expect(f.service.readExecResult({ sessionId: f.id }, { ref: dependency.retention.ref, viaCatalog: saved.ref }), 'A catalog denied by its own current source policy cannot authorize the frame').rejects.toThrow(/unauthorized/)
  } finally { await f.close() }
}, 60000)

it.each(['unknown', 'quota'] as const)('settles actual original native catalog membership before F1: %s', async mode => {
  const f = await fixture('membership-' + mode)
  let released = false, cut = false, bodies = 0, launches = 0, attempts = 0, operationId: string | undefined, partialCount = 0, quotaCalibration: unknown
  const ledger = resolve(f.root, 'native-effects.jsonl')
  await f.mount(async () => {
    bodies++
    for (let n = 0; n < 2; n++) {
      launches++
      expect((await f.exec.run({ argv: [process.execPath, '-e', `require('node:fs').appendFileSync(process.argv[1],'native-${n}\\n');process.stdout.write('native-${n}')`, ledger] })).exitCode).toBe(0)
    }
    return { independentPrimary: true, nativeExits: [0, 0] }
  })
  const membership = f.service.settleResultDependencyMembership.bind(f.service)
  const spy = vi.spyOn(f.service, 'settleResultDependencyMembership').mockImplementation(async (scope, ref) => {
    operationId ??= scope.operationId; expect(scope.operationId).toBe(operationId); attempts++
    const value = await membership(scope, ref)
    if (mode === 'unknown' && cut && !released) throw new Error('original membership publication acknowledgement remains unavailable')
    return value
  })
  const begin = f.service.beginResult.bind(f.service)
  const beginSpy = vi.spyOn(f.service, 'beginResult').mockImplementation(async (scope, codec) => {
    const sink = await begin(scope, codec)
    if (mode === 'quota' && codec === 'json-utf8-v1') {
      const finish = sink.finish.bind(sink)
      sink.finish = async completeness => {
        const saved = await finish(completeness)
        if (!cut && saved.kind === 'committed') {
          const physical = await physicalBytes(f.ownedRoot), quota = physical + 1
          await f.service.configure({ maxDiskBytes: quota }); cut = true
          quotaCalibration = { physical, quota, committedCatalog: saved.ref, reserveRequiresAtLeast: 131072 }
        }
        return saved
      }
    }
    return sink
  })
  cuts.afterRename = async (_from, to) => {
    if (mode !== 'unknown' || cut || !to.replaceAll('\\', '/').includes('/pin-memberships/')) return
    cut = true
    // Inspect direct files while the real original publication still owns its
    // mutation lock. Never ask the store to acquire that lock recursively.
    for (const id of await readdir(f.managed)) {
      const documents = await readdir(resolve(f.managed, id, 'pin-memberships')).catch(() => [])
      for (const document of documents) partialCount += (await readdir(resolve(f.managed, id, 'pin-memberships', document))).filter(name => name.endsWith('.json')).length
    }
    expect(partialCount).toBe(1)
    await writeFile(resolve(f.root, 'partial-membership-receipt.json'), JSON.stringify({ actualRenamedRecord: to, partialCount, operationId }, null, 2))
    throw new Error('controlled real first membership rename acknowledgement unavailable')
  }
  try {
    if (mode === 'unknown') {
      await expect(f.assembly.agent.run('hold original membership publication')).rejects.toBeDefined()
      expect(cut).toBe(true); expect(partialCount).toBe(1); expect(attempts).toBeGreaterThan(0)
      expect(f.assembly.session.events.some(e => e.type === 'tool/result' && e.callId === 'composition')).toBe(false)
      const pendingInventory = await f.inventory(), pendingCatalog = pendingInventory.find(row => row.operation.owner.operationId === operationId)!.operation.ref
      const pendingFrame = pendingInventory.find(row => row.operation.codec === 'exec-frames-v1')!.operation.ref
      await expect(f.service.readExecResult({ sessionId: f.id }, { ref: pendingFrame, viaCatalog: pendingCatalog })).rejects.toThrow(/unauthorized/)
      await writeFile(resolve(f.root, 'pending-membership-checkpoint.json'), JSON.stringify({ operationId, attempts, partialCount, noF1: true, ownFrameStillRequiresVisibleCatalog: true, inventory: pendingInventory }, null, 2))
      released = true
      await (await f.coordinator.openManagedDocument(f.id)).close()
    } else await f.assembly.agent.run('report a known relation quota refusal')
    const result = f.assembly.session.events.find(e => e.type === 'tool/result' && e.callId === 'composition')
    expect(result).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { independentPrimary: true, nativeExits: [0, 0] } } } })
    if (mode === 'quota') {
      expect(result).toMatchObject({ envelope: { dependencies: { kind: 'unavailable', reason: 'quota', count: 2 } } })
      const inventory = await f.inventory(), catalog = inventory.find(row => row.operation.codec === 'json-utf8-v1')!.operation.ref
      const frame = inventory.find(row => row.operation.codec === 'exec-frames-v1')!.operation.ref
      await expect(f.service.readExecResult({ sessionId: f.id }, { ref: frame, viaCatalog: catalog })).rejects.toThrow()
    }
    else {
      if (result?.type !== 'tool/result' || result.envelope?.dependencies?.kind !== 'artifact-set') throw new Error('Expected same-owned recovered dependency catalog')
      const catalog = JSON.parse((await rawBytes(f.service, f.id, result.envelope.dependencies.ref)).toString())
      expect(catalog.entries).toHaveLength(2)
      expect(catalog.entries.map((entry: { retention: { ref: { codec: string } } }) => entry.retention.ref.codec)).toEqual(['exec-frames-v1', 'exec-frames-v1'])
    }
    expect(await readFile(ledger, 'utf8')).toBe('native-0\nnative-1\n')
    expect({ bodies, launches }).toEqual({ bodies: 1, launches: 2 })
    await writeFile(resolve(f.root, 'membership-receipt.json'), JSON.stringify({ mode, operationId, attempts, partialCount, quotaCalibration, result, bodies, launches, inventory: await f.inventory() }, null, 2))
  } finally { released = true; cuts.afterRename = undefined; spy.mockRestore(); beginSpy.mockRestore(); await f.close() }
}, 60000)
