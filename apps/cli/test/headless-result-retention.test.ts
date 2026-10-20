import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveShell } from '@i-harness/shell'
import { deriveMessages } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { runHeadless } from '../src/run.ts'

it('headless shell results use mandatory bounded model/archive envelopes and preserve exact small inline output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'headless-results-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  try {
    const shell = resolveShell().name
    const result = await runHeadless('run two commands', { workspace: root, coordinator, sessionId: id, approveAll: true,
      mockScript: [
        { role: 'assistant', toolCalls: [{ name: shell, args: { command: 'node -e "process.stdout.write(\'y\'.repeat(200000))"' } }] },
        { role: 'assistant', toolCalls: [{ name: shell, args: { command: 'node -e "process.stdout.write(\'small\')"' } }] },
        { role: 'assistant', text: 'done' },
      ],
    })
    expect(result.exitCode).toBe(0)
    const results = result.session!.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    const [big, small] = results
    expect(big).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact' }, dependencies: { kind: 'artifact-set', count: 1 } } })
    expect(small).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', retention: { kind: 'inline', value: { stdout: 'small', stderr: '', exitCode: 0 } } } })
    for (const event of results) {
      expect(event).not.toHaveProperty('output')
      expect(Buffer.byteLength(JSON.stringify(event.envelope))).toBeLessThanOrEqual(64000)
    }
    for (const message of deriveMessages(result.session!).filter(message => message.role === 'tool')) expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(64000)
    // Public cold fact read, not a claim that this test has paged the native body.
    expect((await backend.read(id)).events.filter(event => event.type === 'tool/result')).toEqual(results)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
