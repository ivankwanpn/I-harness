import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createJsonlCommitCoordinator } from '@i-harness/session-persistence-jsonl/internal/commit-coordinator'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { runSessionsCommand } from '../src/sessions.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('selects the store from settings without the environment variable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-cli-store-setting-'))
  roots.push(root)
  const config = join(root, 'config'), sessions = join(root, 'sessions')
  await mkdir(config, { recursive: true })
  await writeFile(join(config, 'settings.json'), JSON.stringify({ sessionStore: 'commit-log' }), 'utf8')
  const seed = asSessionCoordinator(createJsonlCommitCoordinator(sessions, { lock: { enabled: true, lockRoot: sessions } }))
  await seed.create({ sessionId: 's1', title: 'settings store' })
  await seed.close()
  const beforeStore = process.env.IH_SESSION_STORE, beforeConfig = process.env.IH_CONFIG_DIR
  delete process.env.IH_SESSION_STORE
  process.env.IH_CONFIG_DIR = config
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { logs.push(args.map(value => String(value)).join(' ')) }
  try {
    expect(await runSessionsCommand(['sessions', 'list', '--session-dir', sessions, '--json'])).toBe(0)
    expect(logs.join('\n')).toContain('s1')
    // The same directory under a jsonl setting has no such session.
    await writeFile(join(config, 'settings.json'), JSON.stringify({ sessionStore: 'jsonl' }), 'utf8')
    logs.length = 0
    expect(await runSessionsCommand(['sessions', 'list', '--session-dir', sessions, '--json'])).toBe(0)
    expect(logs.join('\n')).not.toContain('s1')
  } finally {
    console.log = original
    if (beforeStore === undefined) delete process.env.IH_SESSION_STORE
    else process.env.IH_SESSION_STORE = beforeStore
    if (beforeConfig === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = beforeConfig
  }
})
