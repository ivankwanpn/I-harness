import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, symlink, unlink, link, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fundSlots, readSlots, terminalSlots, slotCapacity } from '../src/legacy/fork-disposition.ts'
import { physicalBytes } from '../src/artifact/quota.ts'
import { sourceHash } from '../src/legacy/fork-codec.ts'
import { createHash } from 'node:crypto'
const cut = vi.hoisted(() => ({ enabled: false, acquired: undefined as undefined | ((handle: import('node:fs/promises').FileHandle, path: string, flags: unknown) => void) }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args), write = handle.write.bind(handle)
    cut.acquired?.(handle, String(args[0]), args[1])
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

it.each(['symlink', 'hardlink'])('refuses an inactive %s without overwriting the outside original', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-foreign-slot-')), outside = await mkdtemp(join(tmpdir(), 'ih-l1-outside-'))
  const base = join(root, 'original', 'revoke'), tuple = { version: 1 as const, kind: 'legacy-fork-revoked' as const, bindingDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64) }
  await fundSlots(root, base, tuple, 1_000_000, () => {})
  const bytes = Buffer.alloc(slotCapacity(tuple), 42), target = join(outside, 'protected')
  await writeFile(target, bytes); await unlink(base + '.1')
  if (kind === 'symlink') await symlink(target, base + '.1', 'file'); else await link(target, base + '.1')
  const result = await terminalSlots(root, base, tuple, () => {}).catch(error => error)
  expect(await readFile(target)).toEqual(bytes)
  expect(result).toBeInstanceOf(Error)
})
it('refuses redirected original slot parents without changing either outside slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-slots-parent-')), outside = await mkdtemp(join(tmpdir(), 'ih-l1-outside-'))
  const base = join(root, 'original', 'revoke'), tuple = { version: 1 as const, kind: 'legacy-fork-revoked' as const, bindingDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64) }
  await fundSlots(root, base, tuple, 1_000_000, () => {})
  const protectedDirectory = join(outside, 'original'); await rename(join(root, 'original'), protectedDirectory); await symlink(protectedDirectory, join(root, 'original'), 'junction')
  const before = [await readFile(join(protectedDirectory, 'revoke.0')), await readFile(join(protectedDirectory, 'revoke.1'))]
  await expect(terminalSlots(root, base, tuple, () => {})).rejects.toThrow()
  expect(await readFile(join(protectedDirectory, 'revoke.0'))).toEqual(before[0]); expect(await readFile(join(protectedDirectory, 'revoke.1'))).toEqual(before[1])
})
it('retires the acquired inactive original handle when its after-open guard invalidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-slots-guard-')), base = join(root, 'original', 'revoke'), tuple = { version: 1 as const, kind: 'legacy-fork-revoked' as const, bindingDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64) }
  await fundSlots(root, base, tuple, 1_000_000, () => {})
  const before = await readFile(base + '.1'); let invalid = false, acquired: import('node:fs/promises').FileHandle | undefined
  try {
    cut.acquired = (handle, path, flags) => { if (path === base + '.1' && flags === 'r+') { acquired = handle; invalid = true } }
    await expect(terminalSlots(root, base, tuple, () => { if (invalid) throw Error('Original guard invalidated') })).rejects.toThrow(/guard invalidated/)
    expect(acquired?.fd).toBe(-1); expect(await readFile(base + '.1')).toEqual(before)
  } finally { cut.acquired = undefined; await acquired?.close() }
})
it('refuses redirected funding before creating any outside namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-fund-path-')), outside = await mkdtemp(join(tmpdir(), 'ih-l1-outside-'))
  await symlink(outside, join(root, 'redirect'), 'junction')
  const tuple = { version: 1 as const, kind: 'legacy-fork-revoked' as const, bindingDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64) }
  await expect(fundSlots(root, join(root, 'redirect', 'new', 'revoke'), tuple, 1_000_000, () => {})).rejects.toThrow()
  expect(await readdir(outside)).toEqual([])
})
