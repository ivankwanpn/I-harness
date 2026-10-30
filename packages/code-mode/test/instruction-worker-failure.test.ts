import { expect, it, vi } from 'vitest'
vi.mock('node:worker_threads', async original => ({ ...await original<typeof import('node:worker_threads')>(), Worker: class { constructor() { throw new Error('worker construction fault') } } }))
import { createContext } from '@i-harness/core-plugin'
import { createSession } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { registerCodeMode } from '../src/register.ts'

it('settles the original started cell before releasing its pin on worker construction failure', async () => {
  const ctx = createContext(), session = createSession(), origin = Object.freeze({ kind: 'accepted-instruction-call' as const })
  let releases = 0
  const tools = createToolRegistry(ctx, { instructionOriginVerifier: value => value === origin, instructionCellRetainer: () => ({ bind() { return origin }, async preflight() {}, async release() { releases++ } }) })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: 'mixed' } })
  try {
    const capture = tools.capture({ name: 'code_exec', args: { code: 'text(1)' } })
    await expect(tools.dispatch(await tools.prepareCaptured(capture, undefined, origin))).rejects.toThrow('worker construction fault')
    await mount.dispose()
    expect(releases).toBe(1)
    expect(session.events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'failed'])
  } finally { await mount.dispose().catch(() => {}) }
})
