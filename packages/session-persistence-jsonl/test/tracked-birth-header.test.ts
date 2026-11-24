import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { encodeFactBatch, legacyPrefixDigest } from '@i-harness/core-session'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { heldFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { createJsonlBackend } from '../src/index.ts'
import { createBootstrapHeaderBackend } from '../src/backend/bootstrap-header.ts'
import { HEADER_READ_MAX_BYTES } from '../src/backend/header-limit.ts'

const probe = vi.hoisted(() => ({
  path: '', bytes: 0, afterRead: undefined as (() => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async load => {
  const real = await load<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (args[0] === probe.path && args[1] === 'r') {
      const read = handle.read.bind(handle)
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position)
        probe.bytes += result.bytesRead
        const hook = probe.afterRead
        probe.afterRead = undefined
        await hook?.()
        return result
      }) as typeof handle.read
    }
    return handle
  } }
})

async function ordinaryFixture() {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'tracked-birth-header-'))
  const filePath = (id: string) => join(root, id + '.jsonl')
  const id = 'parent', path = filePath(id)
  const ownership = createOwnership(createJsonlBackend(root), { lock: { enabled: true } })
  const claim = await ownership.pinOwnership(id)
  const owner = heldFactOwner({ sessionId: id, incarnation: 'original-birth' }, ownership, () => claim.assertHeld())
  const backend = createBootstrapHeaderBackend(filePath, async () => {}, root)
  backend.trackHeaderOwner(id, owner)
  onTestFinished(async () => {
    probe.path = ''
    probe.afterRead = undefined
    await backend.settleTrackedHeaderIO(id, owner)
    await claim.release()
    await Promise.all(ownership.releaseHeldLocks())
  })
  const journal = { version: 1, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 }
  const header = { formatVersion: 14, sessionId: id, createdAt: '2026-01-01', journal }
  const frame = encodeFactBatch('original', journal.legacyPrefixDigest, [{ type: 'assistant/message', seq: 0, text: 'x'.repeat(HEADER_READ_MAX_BYTES * 3) }])
  const write = (title?: string) => writeFile(path, Buffer.concat([Buffer.from(JSON.stringify({ ...header, title }) + '\n'), frame.bytes]))
  await write()
  probe.path = path
  probe.bytes = 0
  return { path, write, resolve: () => backend.resolveTrackedBirth(id, owner) }
}

it('classifies a large ordinary journal in one header window and still rejects a foreign namespace', async () => {
  const fixture = await ordinaryFixture()
  await expect(fixture.resolve()).resolves.toBeUndefined()
  expect(probe.bytes).toBe(HEADER_READ_MAX_BYTES)
  await writeFile(fixture.path + '.bootstrap-foreign', 'unrelated')
  await expect(fixture.resolve()).rejects.toThrow('Foreign bootstrap namespace')
  expect(probe.bytes).toBe(HEADER_READ_MAX_BYTES * 2)
})

it('checks the original file extent across the bounded positional read', async () => {
  const fixture = await ordinaryFixture()
  probe.afterRead = () => appendFile(fixture.path, 'unexpected suffix')
  await expect(fixture.resolve()).rejects.toThrow('Bootstrap file changed')
  expect(probe.bytes).toBe(HEADER_READ_MAX_BYTES)
})

it('retains whole-file classification for an older header larger than the window', async () => {
  const fixture = await ordinaryFixture()
  await fixture.write('x'.repeat(HEADER_READ_MAX_BYTES))
  await expect(fixture.resolve()).resolves.toBeUndefined()
  expect(probe.bytes).toBeGreaterThan(HEADER_READ_MAX_BYTES * 2)
})
