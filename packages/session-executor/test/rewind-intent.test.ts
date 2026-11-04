import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createRewindIntentLog, readPendingRewindIntents } from '../src/lifecycle/rewind-intent.ts'

it('keeps a rewind pending until completion is written (S-07)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-rewind-intent-'))
  try {
    const hooks = createRewindIntentLog(root, 'session', 3, 'all')!
    await hooks.begin()
    expect(await readPendingRewindIntents(root, 'session')).toEqual([expect.objectContaining({ targetTurn: 3, mode: 'all' })])
    await hooks.complete()
    expect(await readPendingRewindIntents(root, 'session')).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('ignores corrupt intent lines and supports a store without a root (S-07)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-rewind-intent-'))
  try {
    expect(createRewindIntentLog(undefined, 'session', 1, 'files')).toBeUndefined()
    expect(await readPendingRewindIntents(undefined, 'session')).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
