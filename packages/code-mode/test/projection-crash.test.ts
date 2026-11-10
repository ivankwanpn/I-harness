import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'

// A separate native owner exits after sync, before its caller's ACK or cleanup.
it('cold opens one redacted failed result after its original writer crashes before ACK', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'projection-crash-'))
  const here = dirname(fileURLToPath(import.meta.url)), workspace = resolve(here, '../../..')
  const child = spawn(process.execPath, [join(workspace, 'node_modules/tsx/dist/cli.mjs'), join(here, 'helpers/crash-projected-failure.ts'), root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += String(bytes) }); child.stderr.on('data', bytes => { stderr += String(bytes) })
  const status = await new Promise<number | null>((done, reject) => {
    child.once('error', reject); child.once('close', done)
  })
  expect(status, stderr).toBe(0)
  expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ durable: true, bodies: 0, newHooks: 0, writes: 1 })
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    const document = await coordinator.openManagedDocument('crash')
    const results = document.view.events.filter(event => event.type === 'tool/result' && event.callId === 'original-call')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ envelope: { execution: { outcome: 'failed', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { code: 'TOOL_RESULT_PROJECTION_UNAVAILABLE' } } } })
    expect(JSON.stringify(results)).not.toContain('RAW_WORKER_VALUE')
    expect(document.view.events.some(event => event.type === 'agent/delivery-source' && event.kind === 'code')).toBe(false)
  } finally { await coordinator.close() }
  await coordinator.close()
}, 45000)
