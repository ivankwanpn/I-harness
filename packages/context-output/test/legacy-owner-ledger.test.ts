import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, link, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnerLedger, readLedger } from '../src/legacy/owner-ledger.ts'
import { physicalBytes, physicalIdentity, requireSpace } from '../src/artifact/quota.ts'
const cut = vi.hoisted(() => ({ root: '', peak: 0, where: '', enabled: false, noLink: false, shrink: '' }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args), truncate = handle.truncate.bind(handle)
    handle.truncate = async length => { await truncate(length); if (String(args[0]) === cut.shrink) { cut.shrink = ''; throw Error('After canonical whitespace shrink') } }
    return handle
  }, async link(...args: Parameters<typeof fs.link>) { if (cut.noLink) throw Object.assign(Error('Hardlinks unsupported'), { code: 'EOPNOTSUPP' }); await fs.link(...args) }, async rename(...args: Parameters<typeof fs.rename>) {
    if (cut.enabled && cut.root) { const { physicalBytes } = await import('../src/artifact/quota.ts'); cut.peak = Math.max(cut.peak, await physicalBytes(cut.root)) }
    if (cut.where === 'before' && String(args[0]).endsWith('.rewrite')) throw Error('before canonical rename')
    await fs.rename(...args)
    if (cut.where === 'after' && String(args[0]).endsWith('.rewrite')) throw Error('after canonical rename')
  } }
})

it.each(['cross-ref', 'outside'])('refuses an independent scratch hardlinked to a real %s canonical file before any write', async mode => {
  const outer = await mkdtemp(join(tmpdir(), 'ih-l1-cross-alias-')), root = join(outer, 'owned'); await mkdir(root)
  const path = join(root, 'a.json'), victim = mode === 'cross-ref' ? join(root, 'b.json') : join(outer, 'outside.json'), ledger = new OwnerLedger(root)
  const prior = new Set(['source-owner-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'other']), next = new Set([...prior, 'target'])
  await writeFile(path, JSON.stringify([...prior])); await writeFile(victim, '["protected-owner"]'); await link(victim, join(root, 'a.rewrite'))
  const before = [await readFile(path), await readFile(victim)]
  const outcome = await ledger.fund(path, next, 1_000_000, () => {}, 'original').then(() => 'funded', () => 'refused')
  expect.soft(outcome).toBe('refused')
  if (outcome === 'funded') await ledger.replace(path, next, 'original', () => {})
  expect.soft(await readFile(path)).toEqual(before[0]); expect(await readFile(victim)).toEqual(before[1])
})

it('recovers the exact canonical-before-reserve whitespace reclamation cut and permits the next original mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-reclaim-')), path = join(root, 'owners.json'), ledger = new OwnerLedger(root)
  const prior = new Set(['source', 'other', 'target']), next = new Set(['source', 'other'])
  await writeFile(path, JSON.stringify([...prior])); await ledger.fund(path, prior, 1_000_000, () => {}, 'setup')
  cut.shrink = path
  await expect(ledger.replace(path, next, 'clear:target', () => {})).rejects.toThrow(/canonical whitespace shrink/)
  expect((await readLedger(path)).owners).toEqual(next)
  expect((await lstat(join(root, 'owners.rewrite'))).size).toBeGreaterThan((await lstat(path)).size)
  await ledger.recover(path)
  expect((await lstat(join(root, 'owners.rewrite'))).size).toBe((await lstat(path)).size)
  const later = new Set([...next, 'new-target'])
  await ledger.fund(path, later, 1_000_000, () => {}, 'later'); await ledger.replace(path, later, 'later', () => {})
  expect((await readLedger(path)).owners).toEqual(later)
})

it('refuses unsupported hardlinks and foreign aliases before changing any canonical owner set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-unsupported-')), path = join(root, 'owners.json'), ledger = new OwnerLedger(root), prior = new Set(['source', 'other']), next = new Set([...prior, 'target'])
  await writeFile(path, JSON.stringify([...prior])); cut.noLink = true
  try { await expect(ledger.fund(path, next, 1_000_000, () => {}, 'original')).rejects.toThrow(/unsupported/) } finally { cut.noLink = false }
  expect((await readLedger(path)).owners).toEqual(prior)
  await link(path, join(root, 'owners.rewrite'))
  await expect(ledger.fund(path, next, 1_000_000, () => {}, 'original')).rejects.toThrow(/aliases/)
  expect((await readLedger(path)).owners).toEqual(prior)
})
it('counts actual hardlink aliases once and preserves distinct/unknown inode files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-inode-')), a = join(root, 'a'), b = join(root, 'b')
  await writeFile(a, 'original'); await link(a, b); await writeFile(join(root, 'c'), 'original')
  const info = await lstat(a, { bigint: true }); expect(physicalIdentity(info)).toBeTruthy()
  expect(await physicalBytes(root)).toBe(16)
  expect(physicalIdentity({ dev: 0n, ino: 3n })).toBeUndefined(); expect(physicalIdentity({ dev: 1, ino: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined()
})
it('funds a huge canonical owner rewrite and removes an owner at the full physical quota', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-ledger-')), path = join(root, 'owners.json'), ledger = new OwnerLedger(root)
  const prior = new Set(Array.from({ length: 10000 }, (_, i) => `owner-${i}`)), next = new Set([...prior, 'target'])
  await writeFile(path, JSON.stringify([...prior])); expect((await readFile(path)).length).toBeGreaterThan(65536)
  await ledger.fund(path, next, 10_000_000, () => {}, 'grant')
  await ledger.replace(path, next, 'grant', () => {})
  const full = await physicalBytes(root); cut.root = root; cut.peak = 0; cut.enabled = true
  try { await ledger.replace(path, prior, 'clear:target', () => {}) } finally { cut.enabled = false; cut.root = '' }
  expect(cut.peak).toBeLessThanOrEqual(full)
  expect((await readLedger(path)).owners).toEqual(prior)
})
it.each(['before', 'after'])('preserves original canonical owners through the %s-rename crash cut', async where => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-ledger-cut-')), path = join(root, 'owners.json'), ledger = new OwnerLedger(root)
  const prior = new Set(['source', 'other']), next = new Set([...prior, 'target'])
  await writeFile(path, JSON.stringify([...prior])); await ledger.fund(path, next, 1_000_000, () => {}, 'original')
  cut.where = where
  try { await expect(ledger.replace(path, next, 'original', () => {})).rejects.toThrow(/canonical rename/) } finally { cut.where = '' }
  expect((await readLedger(path)).owners).toEqual(where === 'before' ? prior : next)
  const held = await physicalBytes(root)
  await expect(requireSpace(root, held, 1)).rejects.toThrow(/quota/)
  if (where === 'before') { await expect(ledger.recover(path)).rejects.toThrow(/incomplete/); await ledger.replace(path, next, 'original', () => {}) }
  else await ledger.recover(path)
  expect(await physicalBytes(root)).toBeLessThanOrEqual(held)
  expect((await readLedger(path)).owners).toEqual(next)
})

it.each(['before', 'after'])('retains an original selected owner handle across the %s publication cut', async where => {
  const root = await mkdtemp(join(tmpdir(), 'ih-selected-owner-cut-')), path = join(root, 'owners.json'), ledger = new OwnerLedger(root)
  await writeFile(path, '["source"]')
  const original = ledger.createTransfer(path, 'target', 'selected-original'); await original.prepare(() => {})
  await original.fund(1_000_000, () => {})
  cut.where = where
  try { await expect(original.issue(() => {})).rejects.toThrow(/canonical rename/) } finally { cut.where = '' }
  const bytes = await readFile(path)
  if (where === 'before') {
    await expect(original.settle()).rejects.toThrow(/unavailable/)
    expect(await readFile(path)).toEqual(bytes)
    await original.issue(() => {})
  } else await original.settle()
  expect((await readLedger(path)).owners).toEqual(new Set(['source', 'target']))
  await original.issue(() => {}); await original.settle()
  const foreign = ledger.createTransfer(path, 'target', 'selected-original')
  await expect(foreign.prepare(() => {})).rejects.toThrow(/Foreign equal/)
  await expect(foreign.settle()).rejects.toThrow(/not issued/)
})
