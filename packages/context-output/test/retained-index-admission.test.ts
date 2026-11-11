import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LegacyIndexLifecycle } from '../src/legacy/index-lifecycle.ts'
import { createLegacyUseGate } from '../src/legacy/use-gate.ts'
import { physicalBytes } from '../src/artifact/quota.ts'
import type { WorkspaceMutationTurn } from '../src/workspace-mutation.ts'

const hooks = vi.hoisted(() => ({ path: '', beforeInstall: undefined as undefined | (() => void) }))
vi.mock('node:fs/promises', async original => {
  const native = await original<typeof import('node:fs/promises')>()
  return { ...native, async stat(...args: Parameters<typeof native.stat>) {
    const value = await native.stat(...args)
    if (String(args[0]) === hooks.path) hooks.beforeInstall?.()
    return value
  } }
})
const roots: string[] = []
afterEach(async () => {
  hooks.beforeInstall = undefined; hooks.path = ''; vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-retained-index-admission-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])('admits the native retained-index ceiling only while its original writer turn is current (retired=%s)', async retire => {
  const root = await mkdtemp(join(tmpdir(), 'ih-retained-index-admission-')); roots.push(root)
  const gate = createLegacyUseGate(), fault = Error('Original writer turn retired')
  const turn: WorkspaceMutationTurn = { assertCurrent() { if (current !== turn) throw fault } }
  const cleanup: WorkspaceMutationTurn = { assertCurrent() { if (current !== cleanup) throw fault } }
  let current = turn
  const lifecycle = new LegacyIndexLifecycle({ directory: root, assertTurn: active => active.assertCurrent(), assertLease: gate.assertLease,
    physicalBytes: () => physicalBytes(root), witness: async path => createHash('sha256').update(await readFile(path)).digest('hex') })
  await gate.exclusive(undefined, async lease => {
    try {
      expect(await lifecycle.rebuild(turn, lease, 4 * 1024 * 1024, async () => {})).toBe('ready')
      await lifecycle.closeRetaining(turn, lease); await lifecycle.retainWitness(turn, lease)
      const prepare = DatabaseSync.prototype.prepare
      let ceilingWrites = 0
      const statements = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
        if (/^PRAGMA max_page_count=/.test(sql)) ceilingWrites++
        return prepare.call(this, sql)
      })
      hooks.path = join(root, 'index.sqlite')
      hooks.beforeInstall = () => { if (retire) current = cleanup }
      if (retire) {
        await expect(lifecycle.reopenRetained(turn, lease, 4 * 1024 * 1024)).rejects.toBe(fault)
        expect(ceilingWrites).toBe(0)
      } else {
        expect(await lifecycle.reopenRetained(turn, lease, 4 * 1024 * 1024)).toBe(true)
        expect(ceilingWrites).toBe(1)
        expect(lifecycle.use(lease).get('SELECT COUNT(*) AS count FROM refs')).toEqual({ count: 0 })
      }
      statements.mockRestore()
    } finally { hooks.beforeInstall = undefined; current = cleanup; await lifecycle.retire(cleanup, lease) }
  })
}, 15000)
