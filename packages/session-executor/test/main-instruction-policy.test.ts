import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, unlink, rename, symlink } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '@i-harness/settings'
import { createFsWatchService, type FsWatchService, type WatchNotification } from '@i-harness/fs-watch'
import { createSavedInstructionPolicy } from '../src/context/instructions/policy.ts'
import { rmWorkspaceSync } from './helpers.ts'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

it('saved policy follows actual other-store writes/reset/rename and rejects drafts, corrupt/deleted documents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-policy-')), path = join(root, 'settings.json'), watch = createFsWatchService()
  const policy = createSavedInstructionPolicy(path, watch), store = new SettingsStore({ path })
  try {
    await policy.ready()
    expect(policy.current()).toMatchObject({ kind: 'ready', policy: { globalSources: [join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')] } })
    await store.load(); const draft = store.get(); draft.instructions.enabled = false
    expect(policy.current()).toMatchObject({ kind: 'ready', policy: { enabled: true } })
    await store.set({ instructions: { enabled: false, maxBytes: 10, globalSources: [] } })
    await vi.waitFor(() => expect(policy.current()).toMatchObject({ kind: 'ready', policy: { enabled: false, maxBytes: 10, globalSources: [] } }))
    await writeFile(path, '{ broken')
    await vi.waitFor(() => expect(policy.current().kind).toBe('unavailable'))
    await expect(policy.ready()).rejects.toThrow()
    await store.reset()
    await vi.waitFor(() => expect(policy.current()).toMatchObject({ kind: 'ready', policy: { enabled: true, maxBytes: 24000 } }))
    await unlink(path)
    await vi.waitFor(() => expect(policy.current().kind).toBe('unavailable'))
    await expect(policy.ready()).rejects.toThrow()
    const replacement = join(root, 'replacement.json'); await writeFile(replacement, JSON.stringify({ instructions: { enabled: true, maxBytes: 0, globalSources: [] } })); await rename(replacement, path)
    await vi.waitFor(() => expect(policy.current()).toMatchObject({ kind: 'ready', policy: { maxBytes: 0, globalSources: [] } }))
  } finally { await policy.close(); await watch.close(); rmWorkspaceSync(root) }
})

it('covered same-byte recovery fences synchronously and close joins held strict reload while borrowing the parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-policy-held-')), path = join(root, 'settings.json')
  await writeFile(path, JSON.stringify({ instructions: { enabled: true, maxBytes: 24000, globalSources: [] } }))
  let listener: ((value: WatchNotification) => void) | undefined, parentClosed = false, leaseClosed = false
  const watch: FsWatchService = { acquire() { return { ready: Promise.resolve({ epoch: 1, revision: 0 }), subscribe(callback) { listener = callback; queueMicrotask(() => callback({ kind: 'reset', reason: 'initial', cursor: { epoch: 1, revision: 1 } })); return () => {} }, async close() { leaseClosed = true } } }, async close() { parentClosed = true } }
  const policy = createSavedInstructionPolicy(path, watch)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let hold = false, closed = false
  const original = SettingsStore.prototype.loadObserved
  const loading = vi.spyOn(SettingsStore.prototype, 'loadObserved').mockImplementation(async function (this: SettingsStore, options) {
    if (hold) { entered.resolve(); await release.promise }
    return original.call(this, options)
  })
  try {
    await policy.ready(); const previous = policy.current().generation
    hold = true
    listener!({ kind: 'reset', reason: 'recovered', cursor: { epoch: 2, revision: 1 } })
    expect(policy.current().kind).toBe('unavailable')
    expect(policy.current().generation).not.toBe(previous)
    await entered.promise
    const closing = policy.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    release.resolve(); await closing
    expect(leaseClosed).toBe(true); expect(parentClosed).toBe(false)
  } finally { release.resolve(); loading.mockRestore(); await policy.close(); rmWorkspaceSync(root) }
})

it('ENOTDIR is unavailable rather than native first-run defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-policy-notdir-')), parent = join(root, 'file')
  await writeFile(parent, 'regular'); const watch = createFsWatchService(), policy = createSavedInstructionPolicy(join(parent, 'settings.json'), watch)
  try { await expect(policy.ready()).rejects.toThrow(); expect(policy.current().kind).toBe('unavailable') }
  finally { await policy.close(); await watch.close(); rmWorkspaceSync(root) }
})

it.each(['metadata-error', 'broken-parent', 'superseded-leaf'] as const)('first missing rejects %s without widening native home', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-policy-missing-')), path = mode === 'broken-parent' ? join(root, 'broken', 'settings.json') : join(root, 'settings.json')
  if (mode === 'broken-parent') await symlink(join(root, 'absent'), join(root, 'broken'), 'junction')
  const original = fs.lstat
  const metadata = mode === 'metadata-error' ? vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => { if (String(args[0]) === path) throw Object.assign(Error('controlled metadata denied'), { code: 'EACCES' }); return original(...args) }) : undefined
  const strict = SettingsStore.prototype.loadObserved
  const observed = mode === 'superseded-leaf' ? vi.spyOn(SettingsStore.prototype, 'loadObserved').mockImplementation(async function (this: SettingsStore, options) { const result = await strict.call(this, options); if (result.kind === 'missing') await writeFile(path, 'invalid replacement'); return result }) : undefined
  const watch = createFsWatchService(), policy = createSavedInstructionPolicy(path, watch)
  try { await expect(policy.ready()).rejects.toThrow(); expect(policy.current().kind).toBe('unavailable') }
  finally { metadata?.mockRestore(); observed?.mockRestore(); await policy.close(); await watch.close(); rmWorkspaceSync(root) }
})

it('deleting an initially corrupt present profile cannot install first-missing defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-policy-corrupt-first-')), path = join(root, 'settings.json')
  await writeFile(path, '{broken')
  const watch = createFsWatchService(), policy = createSavedInstructionPolicy(path, watch)
  try {
    await expect(policy.ready()).rejects.toThrow()
    const prior = policy.current().generation; await unlink(path)
    await vi.waitFor(() => expect(policy.current().generation).not.toBe(prior))
    await expect(policy.ready()).rejects.toThrow()
    expect(policy.current().kind).toBe('unavailable')
  } finally { await policy.close(); await watch.close(); rmWorkspaceSync(root) }
})

it('an actual failed settings rename leaves only the original saved instruction policy authoritative', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-policy-write-failed-')), path = join(root, 'settings.json'), store = new SettingsStore({ path })
  await store.load(); await store.set({ instructions: { enabled: true, maxBytes: 24000, globalSources: [] } })
  const watch = createFsWatchService(), policy = createSavedInstructionPolicy(path, watch), original = fs.rename
  const failing = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { if (String(args[1]) === path) throw Object.assign(Error('controlled atomic rename refused'), { code: 'EACCES' }); return original(...args) })
  try {
    await policy.ready()
    await expect(store.set({ instructions: { enabled: false, maxBytes: 0, globalSources: [] } })).rejects.toThrow()
    await policy.ready()
    expect(policy.current()).toMatchObject({ kind: 'ready', policy: { enabled: true, maxBytes: 24000, globalSources: [] } })
  } finally { failing.mockRestore(); await policy.close(); await watch.close(); rmWorkspaceSync(root) }
})

it('a rejected first coverage promise can later recover with unchanged bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-policy-recovered-')), path = join(root, 'settings.json')
  await writeFile(path, '{}')
  let notify!: (value: WatchNotification) => void
  const failed = Promise.reject(Error('initial coverage unavailable')); void failed.catch(() => {})
  const watch: FsWatchService = { acquire() { return { ready: failed, subscribe(listener) { notify = listener; return () => {} }, async close() {} } }, async close() {} }, policy = createSavedInstructionPolicy(path, watch)
  try {
    await expect(policy.ready()).rejects.toThrow()
    notify({ kind: 'reset', reason: 'recovered', cursor: { epoch: 2, revision: 1 } })
    await expect(policy.ready()).resolves.toBeUndefined()
    expect(policy.current()).toMatchObject({ kind: 'ready', policy: { enabled: true } })
  } finally { await policy.close(); rmWorkspaceSync(root) }
})

it('notifies original policy subscribers when covered reload becomes ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-policy-notify-')), path = join(root, 'settings.json')
  await writeFile(path, '{}')
  const watch = createFsWatchService(), policy = createSavedInstructionPolicy(path, watch), states: string[] = []
  const unsubscribe = policy.subscribe(() => states.push(policy.current().kind))
  try { await policy.ready(); expect(policy.current().kind).toBe('ready'); expect(states).toContain('ready') }
  finally { unsubscribe(); await policy.close(); await watch.close(); rmWorkspaceSync(root) }
})
