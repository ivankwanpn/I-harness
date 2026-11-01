import { expect, it } from 'vitest'
import { createRoleRegistry, type RoleCleanup } from '../src/roles.ts'
import { persistentRoleRegistry } from '../src/persist.ts'

it.each([undefined, false])('original registration cleanup retries failed bookkeeping without removing a foreign entry (%j)', async cause => {
  const original = createRoleRegistry(), installed = Promise.withResolvers<void>()
  const saves: string[][] = []
  let cleanupPhase = false, refused = true, removals = 0
  const roles = persistentRoleRegistry(original, async () => {
    saves.push(original.list().map(role => role.name))
    if (!cleanupPhase) { installed.resolve(); return }
    if (refused) throw cause
  })
  const retained: { cleanup?: RoleCleanup } = {}
  const role = { name: 'original', description: 'p', systemPrompt: 'p', tools: [] }
  roles.register(role, cleanup => { retained.cleanup = cleanup })
  await installed.promise
  original.onChanged(() => { if (!original.get(role.name)) removals++ })
  cleanupPhase = true
  await expect(Promise.resolve().then(() => retained.cleanup!())).rejects.toBe(cause)
  expect(original.get(role.name)).toBeUndefined(); expect(removals).toBe(1)
  // Even the same role object gets a new private registration entry.
  original.register(role); refused = false
  await retained.cleanup!()
  expect(original.get(role.name)).toBe(role); expect(removals).toBe(1)
  expect(saves).toEqual([['original'], [], ['original']])
  await retained.cleanup!(); expect(saves).toHaveLength(3)
})

it('a retained registration can be closed reentrantly before publication without a late role effect', () => {
  const roles = createRoleRegistry()
  expect(() => roles.register({ name: 'never-installed', description: 'p', systemPrompt: 'p', tools: [] }, cleanup => { void cleanup() })).toThrow('Original role registration retired')
  expect(roles.list()).toEqual([])
})

it('persistent registration forwards the synchronous original retirement fence before asynchronous save', async () => {
  const original = createRoleRegistry(), roles = persistentRoleRegistry(original, async () => {})
  const held: { close?: ReturnType<RoleCleanup> } = {}
  expect(() => roles.register({ name: 'never-published', description: 'p', systemPrompt: 'p', tools: [] }, cleanup => { held.close = cleanup() })).toThrow('Original role registration retired')
  await held.close
  expect(original.list()).toEqual([])
})

it('cleanup keeps the original registration key when the caller later edits its role object', () => {
  const roles = createRoleRegistry(), retained: { cleanup?: RoleCleanup } = {}
  const role = { name: 'original-key', description: 'p', systemPrompt: 'p', tools: [] }
  roles.register(role, cleanup => { retained.cleanup = cleanup })
  role.name = 'edited-object'
  void retained.cleanup!()
  expect(roles.get('original-key')).toBeUndefined()
  expect(roles.list()).toEqual([])
})
