import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, open, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { observeColdExecutionWrites } from '../src/coordinator/cold-execution-writes.ts'
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, open: vi.fn(fs.open), readFile: vi.fn(fs.readFile) } })

it.each(['sync-rollback', 'close-after-sync', 'close-recheck-denied'] as const)('preserves original issued %s failure, bytes, queued debt and recovery dirtiness', async mode => {
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'cold-issued-')), path = join(root, 's.jsonl')
  const fault = Object.freeze({ original: mode }), counters = { writes: 0, syncs: 0, rollbacks: 0, closes: 0, faults: 0, deniedRechecks: 0 }
  let armed = false, denyRead = false
  let collecting: string[] | undefined
  const repairAdmissions: string[][] = []
  vi.mocked(readFile).mockImplementation(async (...args: any[]) => {
    // Capture the admission before the ORIGINAL repair read completes. Keep
    // the existing append-only failure/rollback oracles below unchanged.
    if (collecting && String(args[0]) === path && new Error().stack?.includes('Object.repair')) repairAdmissions.push(collecting.splice(0))
    return (native.readFile as any)(...args)
  })
  vi.mocked(open).mockImplementation(async (...args) => {
    // historyChanged uses the original streamed archive read, not fs.readFile.
    // Deny that first real descriptor acquisition after the lost close ACK.
    if (denyRead && String(args[0]) === path && args[1] === 'r') { denyRead = false; counters.deniedRechecks++; throw Error('secondary recheck denied') }
    const handle = await native.open(...args)
    if (String(args[0]) !== path || args[1] !== 'r+') return handle
    let wrote = false
    return new Proxy(handle, { get(target, key) {
      if (key === 'write') return async (...values: Parameters<typeof target.write>) => { const result = await target.write(...values); wrote = true; counters.writes++; return result }
      if (key === 'sync') return async () => { if (wrote) counters.syncs++; if (armed && wrote && mode === 'sync-rollback') { armed = false; counters.faults++; throw fault }; return target.sync() }
      if (key === 'truncate') return async (length: number) => { counters.rollbacks++; return target.truncate(length) }
      if (key === 'close') return async () => { if (wrote) counters.closes++; await target.close(); if (armed && wrote && mode !== 'sync-rollback') { armed = false; counters.faults++; denyRead = mode === 'close-recheck-denied'; throw fault } }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  const backend = createJsonlBackend(root), append = backend.append
  const options = { lock: { enabled: true, lockRoot: root }, maxDelayMs: 600_000, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract)
  const foreign = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), options, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 's' })
    const before = await readFile(path), event = { type: 'plan/mode' as const, mode: 'on' as const, seq: 0 }
    const seen: string[] = []; const off = observeColdExecutionWrites(coordinator, id => seen.push(id))
    collecting = seen
    armed = true; coordinator.enqueue('s', [event])
    let failure: unknown
    try { await coordinator.flush('s') } catch (error) { failure = error }
    expect(failure).toMatchObject({ message: 'TASK_TRANSITION_FAILED', cause: fault })
    expect(repairAdmissions).toEqual([['s']])
    expect((failure as Error).cause).toBe(fault); expect(backend.append).toBe(append)
    expect(counters.faults).toBe(1); expect(counters.writes).toBe(1)
    expect(counters.closes).toBe(1); expect(counters.syncs).toBe(mode === 'sync-rollback' ? 2 : 1)
    expect(counters.deniedRechecks).toBe(mode === 'close-recheck-denied' ? 1 : 0)
    const failedBytes = await readFile(path)
    if (mode === 'sync-rollback') { expect(counters.rollbacks).toBe(1); expect(failedBytes).toEqual(before); expect(seen).toEqual([]) }
    else { expect(counters.rollbacks).toBe(0); expect(failedBytes.subarray(0, before.length)).toEqual(before); expect(failedBytes.length).toBeGreaterThan(before.length); expect((await backend.read('s')).events).toEqual([event]) }
    // The original write-behind batch survives the failure. No replacement
    // backend method, second writer, or reconstructed event is supplied.
    await expect(foreign.adoptOwnership('s')).rejects.toThrow()
    await expect(coordinator.flush('s')).rejects.toThrow('PROCESS_READ_UNAVAILABLE')
    if (mode !== 'sync-rollback') expect(seen).toEqual(['s'])
    await expect(coordinator.close()).rejects.toThrow('Failed to persist sessions during shutdown')
    expect(coordinator.hasLiveOwnership?.('s')).toBe(false)
    // Reopen via the other genuine original coordinator only after the first
    // has released native ownership. Its poisoned pending batch was reported,
    // never silently acknowledged or retried in the old incarnation.
    collecting = undefined
    await foreign.adoptOwnership('s')
    const recovered: string[] = []; const offRecovery = observeColdExecutionWrites(foreign, id => recovered.push(id))
    collecting = recovered
    foreign.enqueue('s', [event]); await foreign.flush('s')
    expect((await backend.read('s')).events).toEqual([event])
    expect(mode !== 'sync-rollback' ? seen : recovered).toEqual(['s'])
    if (mode !== 'sync-rollback') expect(recovered).toEqual([])
    if (mode !== 'sync-rollback') { expect(await readFile(path)).toEqual(failedBytes); expect(counters.writes).toBe(1) }
    else expect(counters.writes).toBe(2)
    await foreign.flush('s'); expect(mode !== 'sync-rollback' ? seen : recovered).toEqual(['s'])
    off(); offRecovery(); await foreign.releaseOwnership('s')
    expect(repairAdmissions.every(edges => edges.length === 1 && edges[0] === 's')).toBe(true)
  } finally { armed = false; await Promise.allSettled([coordinator.close(), foreign.close()]); vi.mocked(open).mockImplementation(native.open); vi.mocked(readFile).mockImplementation(native.readFile); await rm(root, { recursive: true, force: true }) }
})
