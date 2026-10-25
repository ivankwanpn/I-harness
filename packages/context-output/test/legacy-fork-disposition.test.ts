import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fundSlots, readSlots, terminalSlots, slotCapacity } from '../src/legacy/fork-disposition.ts'
import { physicalBytes } from '../src/artifact/quota.ts'
import { sourceHash } from '../src/legacy/fork-codec.ts'
import { createHash } from 'node:crypto'
const cut = vi.hoisted(() => ({ enabled: false }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args), write = handle.write.bind(handle)
    handle.write = (async (...params: Parameters<typeof write>) => {
      if (cut.enabled && String(args[0]).endsWith('revoke.0')) { cut.enabled = false; const [bytes, offset, length, position] = params as unknown as [Uint8Array, number, number, number]; await write(bytes, offset, Math.min(19, length), position); throw Error('Original slot allocation cut') }
      return write(...params)
    }) as typeof handle.write
    return handle
  } }
})
it('continues only the original partially allocated fixed slots and revokes at their full physical quota', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-slots-')), base = join(root, 'original', 'revoke'), tuple = { version: 1 as const, kind: 'legacy-fork-revoked' as const, bindingDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64) }
  cut.enabled = true
  await expect(fundSlots(root, base, tuple, 1_000_000, () => {})).rejects.toThrow(/allocation cut/)
  expect(await physicalBytes(root)).toBe(19)
  await fundSlots(root, base, tuple, 1_000_000, () => {})
  expect(await physicalBytes(root)).toBe(2 * slotCapacity(tuple)); expect(await readSlots(root, base, tuple)).toBe('live')
  const before = await physicalBytes(root); await terminalSlots(root, base, tuple, () => {})
  expect(await physicalBytes(root)).toBe(before); expect(await readSlots(root, base, tuple)).toBe('terminal')
  await expect(fundSlots(root, base, tuple, before, () => {})).rejects.toThrow()
})
it('fences a torn inactive slot and completes only its deterministic terminal tuple under explicit authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-torn-')), base = join(root, 'original', 'revoke'), tuple = { version: 1 as const, kind: 'legacy-fork-revoked' as const, bindingDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64) }
  await fundSlots(root, base, tuple, 1_000_000, () => {})
  const torn = await readFile(base + '.1'); torn[0] = 1; await writeFile(base + '.1', torn)
  expect(await readSlots(root, base, tuple)).toBe('unknown')
  expect(await readFile(base + '.1')).toEqual(torn)
  await terminalSlots(root, base, tuple, () => {}); expect(await readSlots(root, base, tuple)).toBe('terminal')
})
it('streams an unbounded source identity into the fixed digest without altering source policy', () => {
  const source = 'source-😀-"-\\-'.repeat(100000)
  expect(sourceHash(source)).toBe(createHash('sha256').update('ih.legacy-fork.target-source.v1\0').update(JSON.stringify(source)).digest('hex'))
})
