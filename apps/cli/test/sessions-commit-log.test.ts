import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createJsonlCommitCoordinator } from '@i-harness/session-persistence-jsonl/internal/commit-coordinator'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { runSessionsCommand } from '../src/sessions.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('lists commit-log sessions through the sessions command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ih-cli-sessions-scl-'))
  roots.push(dir)
  const seed = asSessionCoordinator(createJsonlCommitCoordinator(dir, { lock: { enabled: true, lockRoot: dir } }))
  await seed.create({ sessionId: 's1', title: 'Commit log session' })
  await seed.close()
  const before = process.env.IH_SESSION_STORE
  process.env.IH_SESSION_STORE = 'commit-log'
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { logs.push(args.map(value => String(value)).join(' ')) }
  try {
    expect(await runSessionsCommand(['list', '--session-dir', dir, '--json'])).toBe(0)
    const listed = logs.join('\n')
    expect(listed).toContain('s1')
    expect(listed).toContain('Commit log session')
  } finally {
    console.log = original
    if (before === undefined) delete process.env.IH_SESSION_STORE
    else process.env.IH_SESSION_STORE = before
  }
})
