import { expect, it, vi } from 'vitest'
type StreamFault = {
  reads: Array<{ descriptor: symbol; capacity: number; position: number; bytesRead: number }>
  changedByte?: number
}
const faults = vi.hoisted(() => ({ target: '', fail: false, closes: 0, stream: undefined as StreamFault | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === faults.target && args[1] === 'r') {
      const close = handle.close.bind(handle)
      handle.close = async () => { faults.closes++; if (faults.fail) throw false; await close() }
      if (faults.stream) {
        const stream = faults.stream
        const read = handle.read.bind(handle)
        const descriptor = Symbol()
        handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await read(buffer, offset, Math.min(length, 4093), position)
          stream.reads.push({ descriptor, capacity: buffer.length, position, bytesRead: result.bytesRead })
          const changedByte = stream.changedByte
          // Simulate changed bytes visible through the original descriptor while every stat is unchanged.
          if (changedByte !== undefined && changedByte >= position && changedByte < position + result.bytesRead) {
            const index = offset + changedByte - position
            buffer[index] = buffer[index]! ^ 1
          }
          return result
        }) as typeof handle.read
      }
    }
    return handle
  } }
})
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend, lookupJsonlProcessRead } from '../src/backend-factory.ts'
import { createPredecessorSession } from './helpers/predecessor.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { issueHeldTaskDocumentScope } from '../../session-persistence/src/coordinator/task-document-scope.ts'

it('retains the original history file close failure until explicit settlement', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-history-debt-'))
  const backend = createJsonlBackend(root), owner = createOwnership(backend, { lock: { enabled: true } })
  const pin = await owner.pinOwnership('p'), lease = await owner.acquireLease('doc:task-p')
  const scope = issueHeldTaskDocumentScope(owner, 'p', pin, { assertActive() { if (!lease.held) throw Error('revoked') } })
  try {
    await createPredecessorSession(backend, root, 'p', 13, '2026-01-01')
    faults.target = join(root, 'p.jsonl'); faults.fail = true; faults.closes = 0
    const reader = lookupJsonlProcessRead(backend)!.openTaskHistory(scope)
    await expect(reader.observe()).rejects.toBe(false)
    await expect(reader.settleResources()).rejects.toBe(false)
    expect(faults.closes).toBe(2); faults.fail = false
    await reader.settleResources(); expect(faults.closes).toBe(3)
    await expect(reader.observe()).rejects.toBe(false)
  } finally { faults.fail = false; faults.target = ''; await lease.release(); await pin.release(); await rm(root, { recursive: true, force: true }) }
})

it('rechecks exact Task history bytes with one bounded descriptor stream and retains its cleanup debt', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-history-stream-'))
  const backend = createJsonlBackend(root)
  const owner = createOwnership(backend, { lock: { enabled: true } })
  const pin = await owner.pinOwnership('p')
  const lease = await owner.acquireLease('doc:task-p')
  const scope = issueHeldTaskDocumentScope(owner, 'p', pin, { assertActive() { if (!lease.held) throw Error('revoked') } })
  const capability = lookupJsonlProcessRead(backend)!
  const reader = capability.openTaskHistory(scope)
  const path = join(root, 'p.jsonl')
  const raw = Buffer.from([
    JSON.stringify({ sessionId: 'p', formatVersion: 5, createdAt: 'x' }),
    JSON.stringify({ type: 'user/message', text: '雪😀'.repeat(24000) }),
    '',
  ].join('\n'))
  const stream: StreamFault = { reads: [] }
  try {
    await writeFile(path, raw)
    faults.target = path
    faults.stream = stream
    faults.closes = 0
    const history = await reader.observe()
    expect(capability.originalHistory(history, scope).bytes.equals(raw)).toBe(true)
    stream.reads.length = 0
    await history.assertCurrent()
    expect(new Set(stream.reads.map(read => read.descriptor)).size).toBe(1)
    expect(stream.reads.length).toBeGreaterThan(32)
    expect(Math.max(...stream.reads.map(read => read.capacity))).toBeLessThanOrEqual(65536)
    expect(stream.reads.at(-1)).toMatchObject({ position: raw.length, bytesRead: 0 })

    stream.changedByte = raw.length - 8
    await expect(history.assertCurrent()).rejects.toThrow('PROCESS_READ_UNAVAILABLE')
    stream.changedByte = undefined

    faults.fail = true
    await expect(history.assertCurrent()).rejects.toBe(false)
    expect(reader.hasDebt()).toBe(true)
    const failedCloseCount = faults.closes
    await expect(history.assertCurrent()).rejects.toThrow('TASK_HISTORY_UNAVAILABLE')
    expect(faults.closes).toBe(failedCloseCount)
    faults.fail = false
    await reader.retryResources()
    expect(faults.closes).toBe(failedCloseCount + 1)
    expect(reader.hasDebt()).toBe(false)
    await history.assertCurrent()
    await reader.settleResources()
    await expect(history.assertCurrent()).rejects.toThrow('TASK_HISTORY_UNAVAILABLE')
  } finally {
    faults.fail = false
    faults.stream = undefined
    try { await reader.settleResources() }
    finally { faults.target = ''; await lease.release(); await pin.release(); await rm(root, { recursive: true, force: true }) }
  }
})
