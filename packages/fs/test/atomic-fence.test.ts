import { it, expect } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../src/atomic.ts'
import { createFsTools } from "./helpers/registry-fs.ts"

it('fences each atomic syscall and preserves the original bytes when rename is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-fence-')), target = join(root, 'file.txt'), seen: string[] = []
  try {
    await writeFile(target, 'original')
    await expect(writeFileAtomic(target, 'replacement', undefined, boundary => { seen.push(`${boundary.operation}:${boundary.target}`); if (boundary.operation === 'rename') throw new Error('revoked') })).rejects.toThrow('revoked')
    expect(seen).toEqual([`mkdir:${target}`, `temp-write:${target}`, `rename:${target}`])
    expect(await readFile(target, 'utf8')).toBe('original')
    expect(await readdir(root)).toEqual(['file.txt'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rechecks sandbox authority immediately before atomic edit rename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-edit-fence-')), target = join(root, 'file.txt')
  try {
    await writeFile(target, 'old')
    let checks = 0
    const tool = createFsTools({ workspace: root, writeGuard() {
      checks++
      if (checks === 5) return { ok: false as const, denial: { code: 'SANDBOX_DENIED', reason: 'revoked', surface: 'fs' } as never }
      return { ok: true as const }
    } }).find(t => t.name === 'edit')!
    const result = await tool.execute({ path: target, old_string: 'old', new_string: 'new' }, {}) as { code?: string }
    expect(result.code).toBe('FS_SANDBOX_DENIED')
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual(['file.txt'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reports patch rename refusal while preserving prior bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-patch-fence-')), target = join(root, 'file.txt')
  try {
    await writeFile(target, 'old\n')
    let checks = 0
    const tool = createFsTools({ workspace: root, writeGuard() {
      checks++
      if (checks === 5) return { ok: false as const, denial: { code: 'SANDBOX_DENIED', reason: 'revoked', surface: 'fs' } as never }
      return { ok: true as const }
    } }).find(t => t.name === 'apply_patch')!
    const patch = '*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n*** End Patch\n'
    const result = await tool.execute({ patch_content: patch }, {}) as { applied: unknown[]; errors: unknown[] }
    expect(result.applied).toEqual([]); expect(result.errors).toHaveLength(1)
    expect(await readFile(target, 'utf8')).toBe('old\n')
    expect(await readdir(root)).toEqual(['file.txt'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
