import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { createFsWatchService } from '@i-harness/fs-watch'
import { createInstructionObservationOwner, createObservedInstructionService, type InstructionScope } from '../src/index.ts'
import { temporary, gate } from './helpers/observation-fixture.ts'
import * as interests from '../src/observation/interests.ts'

it('held host-native mutation marks two applicable Sessions pending while independent root stays ready', async () => {
  const temp = await temporary(), watch = createFsWatchService(), owner = createInstructionObservationOwner(watch)
  const aRoot = join(temp.root, 'a'), bRoot = join(temp.root, 'b')
  await mkdir(aRoot); await mkdir(bRoot); await writeFile(join(aRoot, 'CLAUDE.md'), 'fallback')
  const scope = (root: string): InstructionScope => ({ cwd: root, roots: [root], globalSources: [], enabled: true, maxBytes: 24000 })
  const a = createObservedInstructionService({ scope: scope(aRoot), observation: owner }), b = createObservedInstructionService({ scope: scope(aRoot), observation: owner })
  const independent = createObservedInstructionService({ scope: scope(bRoot), observation: owner })
  const hold = gate(), started = gate(), candidate = join(aRoot, 'AGENTS.md')
  try {
    await Promise.all([a.prepare([]), b.prepare([]), independent.prepare([])])
    const operation = (async () => {
      const token = owner.beginPending([candidate])
      try { started.resolve(); await hold.promise; await writeFile(candidate, 'native body'); return 'actual result' }
      finally { token.settle() }
    })()
    await started.promise
    expect(a.snapshot().reliability).toBe('pending'); expect(b.snapshot().reliability).toBe('pending')
    expect(independent.snapshot().reliability).toBe('ready')
    await a.close(); hold.resolve(); expect(await operation).toBe('actual result')
    const snapshot = await b.prepare([])
    expect(snapshot.candidates.every(candidate => !candidate.pendingIds.length)).toBe(true)
    expect(snapshot.text).toContain('native body')
  } finally { hold.resolve(); await Promise.allSettled([a.close(), b.close(), independent.close()]); await owner.close(); await watch.close(); await temp.remove() }
})

it('absent, shadowed, global and verified canonical candidates keep independent tokens across replacement', async () => {
  const temp = await temporary(), watch = createFsWatchService(), owner = createInstructionObservationOwner(watch)
  const actual = join(temp.root, 'actual'), alias = join(temp.root, 'alias'), global = join(temp.root, 'global', 'AGENTS.md')
  await mkdir(actual); await mkdir(join(temp.root, 'global')); await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(actual, 'AGENTS.md'), 'preferred'); await writeFile(join(actual, 'CLAUDE.md'), 'shadow')
  const scope: InstructionScope = { cwd: alias, roots: [temp.root], globalSources: [global], enabled: true, maxBytes: 24000 }
  const service = createObservedInstructionService({ scope, observation: owner })
  let replacement = service
  try {
    const before = owner.beginPending([join(actual, 'CLAUDE.md'), global])
    await service.prepare([])
    expect(service.snapshot().reliability).toBe('pending')
    const after = owner.beginPending([join(alias, 'AGENTS.md')])
    await service.close()
    replacement = createObservedInstructionService({ scope, observation: owner }); await replacement.prepare([])
    expect(replacement.snapshot().candidates.flatMap(candidate => candidate.pendingIds)).toContain(before.id)
    before.settle(); before.settle()
    expect(replacement.snapshot().candidates.flatMap(candidate => candidate.pendingIds)).toContain(after.id)
    after.settle(); await replacement.prepare([])
    expect(replacement.snapshot().candidates.every(candidate => candidate.pendingIds.length === 0)).toBe(true)
  } finally { await replacement.close(); await owner.close(); await watch.close(); await temp.remove() }
})

it('failed/partial mutations settle in finally, capacity precedes I/O, and late settle is harmless', async () => {
  const temp = await temporary(), watch = createFsWatchService(), owner = createInstructionObservationOwner(watch)
  const scope: InstructionScope = { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
  const service = createObservedInstructionService({ scope, observation: owner })
  try {
    await service.prepare([])
    const mutationError = new Error('actual partial failure')
    await expect((async () => {
      const token = owner.beginPending([join(temp.root, 'AGENTS.md')])
      try { await writeFile(join(temp.root, 'AGENTS.md'), 'partial'); throw mutationError }
      finally { token.settle(); token.settle() }
    })()).rejects.toBe(mutationError)
    expect(service.snapshot().candidates.every(candidate => !candidate.pendingIds.length)).toBe(true)
    expect(() => owner.beginPending(Array.from({ length: 257 }, () => join(temp.root, 'AGENTS.md')))).toThrow('capacity')
    const tokens = Array.from({ length: 256 }, () => owner.beginPending([join(temp.root, 'AGENTS.md')]))
    expect(() => owner.beginPending([join(temp.root, 'AGENTS.md')])).toThrow('capacity')
    await owner.close(); for (const token of tokens) token.settle()
    expect(() => owner.beginPending([])).toThrow('closed')
  } finally { await service.close(); await owner.close(); await watch.close(); await temp.remove() }
})
it('internal pending mapping failure latches unavailable without changing the native mutation result', async () => {
  const temp = await temporary(), watch = createFsWatchService(), owner = createInstructionObservationOwner(watch)
  const view = createObservedInstructionService({ scope: { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }, observation: owner })
  try {
    await view.prepare([])
    vi.spyOn(interests, 'matchPaths').mockImplementationOnce(() => { throw new Error('injected mapping failure') })
    const token = owner.beginPending([join(temp.root, 'AGENTS.md')])
    expect(view.snapshot().reliability).toBe('unavailable')
    const actual = await (async () => { try { return 'native result' } finally { token.settle() } })()
    expect(actual).toBe('native result'); expect(view.snapshot().reliability).toBe('unavailable')
    vi.restoreAllMocks(); expect((await view.prepare([])).reliability).toBe('ready')
  } finally { vi.restoreAllMocks(); await view.close(); await owner.close(); await watch.close(); await temp.remove() }
})
