import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rename, rm, rmdir, symlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const observed = vi.hoisted(() => ({ opens: 0, details: 0, folds: 0, beforeOpen: undefined as undefined | ((path: string) => void) }))
vi.mock('../src/win32-artifact-api.ts', async original => {
  const native = await original<typeof import('../src/win32-artifact-api.ts')>()
  let api: ReturnType<typeof native.win32ArtifactApi> | undefined
  return { ...native, win32ArtifactApi() {
    if (!api) {
      const originalApi = native.win32ArtifactApi()
      api = Object.freeze({ ...originalApi, createFileW(...args: Parameters<typeof originalApi.createFileW>) {
        observed.opens++
        observed.beforeOpen?.(args[0])
        return originalApi.createFileW(...args)
      }, getFileInformationByHandleEx(...args: Parameters<typeof originalApi.getFileInformationByHandleEx>) {
        observed.details++
        return originalApi.getFileInformationByHandleEx(...args)
      }, lcMapStringEx(...args: Parameters<typeof originalApi.lcMapStringEx>) {
        observed.folds++
        return originalApi.lcMapStringEx(...args)
      } })
    }
    return api
  } }
})
import { createWin32ArtifactPathOwner, createWin32ArtifactPathOwnerWithApi, checkWin32ArtifactPaths } from '../src/win32-artifact-path.ts'
import { win32ArtifactApi } from '../src/win32-artifact-api.ts'

const roots: string[] = []
afterEach(async () => {
  observed.beforeOpen = undefined
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-native-path-batch-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ih-native-path-batch-')); roots.push(directory)
  const root = join(directory, 'sessions'); await mkdir(join(root, 'locks'), { recursive: true })
  if (dirname(resolve(root)) !== resolve(directory) || dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('ih-native-path-batch-')) throw Error('Unsafe fixture paths')
  const owner = createWin32ArtifactPathOwner(root)
  const captures = [owner.capture(join(root, 'source.jsonl')), owner.capture(join(root, 'task-source.jsonl')), owner.capture(join(root, 'locks', 'source.lock'))]
  const checks = captures.map(capture => ({ capture, method: capture.assertCurrent }))
  return { directory, root, owner, captures, checks }
}
const windows = it.skipIf(process.platform !== 'win32')
windows('shares only same-pass native ancestor samples and independently validates both passes', async () => {
  const f = await fixture()
  try {
    expect(observed.folds).toBeGreaterThan(0)
    observed.opens = observed.details = observed.folds = 0
    for (const capture of f.captures) capture.assertCurrent()
    expect(observed.opens).toBe(8)
    expect(observed.details).toBe(48)
    expect(observed.folds).toBe(0)
    observed.opens = observed.details = 0
    checkWin32ArtifactPaths(f.checks)
    expect(observed.opens).toBe(6)
    expect(observed.details).toBe(18)
    await Promise.resolve()
    checkWin32ArtifactPaths(f.checks)
    expect(observed.opens).toBe(12)
  } finally { f.owner.settleResources() }
})
windows('retains native Unicode key derivation while injected currentness mapping remains immediate', async () => {
  const f = await fixture(), injected = createWin32ArtifactPathOwnerWithApi(f.root, win32ArtifactApi())
  try {
    const path = join(f.root, 'i-İ-ß-σ-😀.doc.jsonl')
    const native = f.owner.capture(path), custom = injected.capture(path)
    expect(native.kind === 'ready' && native.key).toBe(custom.kind === 'ready' && custom.key)
    observed.folds = 0
    native.assertCurrent()
    expect(observed.folds).toBe(0)
    custom.assertCurrent()
    expect(observed.folds).toBeGreaterThan(0)
  } finally { f.owner.settleResources(); injected.settleResources() }
})
windows('revalidates the root after an external process moves the original child beneath a replacement root', async () => {
  const f = await fixture(), old = join(f.directory, 'old')
  let changed = false
  try {
    observed.beforeOpen = path => {
      if (changed || path !== join(f.root, 'locks')) return
      changed = true
      const result = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs'); const path = require('node:path');
        const os = require('node:os');
        const [root, old] = process.argv.slice(1);
        const parent = path.dirname(path.resolve(root));
        if (path.dirname(path.resolve(old)) !== parent || path.dirname(parent) !== path.resolve(os.tmpdir()) || !path.basename(parent).startsWith('ih-native-path-batch-')) throw Error('Unsafe fixture move');
        fs.renameSync(root, old); fs.mkdirSync(root);
        fs.renameSync(path.join(old, 'locks'), path.join(root, 'locks'));
      `, f.root, old], { encoding: 'utf8', windowsHide: true })
      if (result.status !== 0) throw Error(result.stderr || String(result.error))
    }
    expect(() => checkWin32ArtifactPaths(f.checks)).toThrow('Original artifact root changed')
    expect(changed).toBe(true)
    observed.beforeOpen = undefined
    // Even restoring the same original root cannot revive this failed batch.
    await rename(join(f.root, 'locks'), join(old, 'locks')); await rmdir(f.root); await rename(old, f.root)
    expect(() => f.captures[0]!.assertCurrent()).toThrow('capture unavailable')
  } finally { observed.beforeOpen = undefined; f.owner.settleResources() }
})
windows('ends a sampling interval before an opaque callback and retains retirement across root ABA', async () => {
  const f = await fixture(), old = join(f.directory, 'old')
  try {
    const custom = { assertCurrent() { throw Error('opaque callback') } }
    expect(() => checkWin32ArtifactPaths([f.checks[0]!, { capture: custom, method: custom.assertCurrent }, f.checks[1]!])).toThrow('opaque callback')
    await rename(f.root, old); await mkdir(f.root)
    expect(() => checkWin32ArtifactPaths([f.checks[1]!])).toThrow('Original artifact root changed')
    await rmdir(f.root); await rename(old, f.root)
    expect(() => checkWin32ArtifactPaths([f.checks[1]!])).toThrow('capture unavailable')
  } finally { f.owner.settleResources() }
})
windows('refuses a directory junction alias and does not carry samples over a native mutation', async () => {
  const f = await fixture(), outside = join(f.directory, 'outside'), alias = join(f.root, 'alias')
  try {
    await mkdir(outside); await symlink(outside, alias, 'junction')
    expect(() => f.owner.capture(join(alias, 'source.jsonl'))).toThrow('non-reparse directory')
    checkWin32ArtifactPaths(f.checks)
    await rename(join(f.root, 'locks'), join(f.root, 'old-locks')); await mkdir(join(f.root, 'locks'))
    expect(() => checkWin32ArtifactPaths([f.checks[2]!])).toThrow('Original artifact path changed')
  } finally { f.owner.settleResources() }
})
windows.each(['callback', 'descriptor'] as const)('resamples after an opaque %s replaces a previously sampled root', async boundary => {
  const f = await fixture(), old = join(f.directory, 'old')
  let changed = false
  const mutate = () => { if (!changed) { changed = true; renameSync(f.root, old); mkdirSync(f.root) } }
  const custom = { assertCurrent() { if (boundary === 'callback') mutate() } }
  const capture = boundary === 'descriptor' ? new Proxy(custom, { getOwnPropertyDescriptor(target, key) { mutate(); return Reflect.getOwnPropertyDescriptor(target, key) } }) : custom
  try {
    expect(() => checkWin32ArtifactPaths([f.checks[0]!, { capture, method: custom.assertCurrent }, f.checks[1]!])).toThrow('Original artifact root changed')
    expect(changed).toBe(true)
  } finally { f.owner.settleResources() }
})
