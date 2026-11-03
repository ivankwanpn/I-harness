import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionAssembly } from '../src/assembly.ts'
import { controlledModel } from './controlled-model.ts'

it('acquires the actual custom JSONL workspace result owner without a supplied Desktop service', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-host-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'custom-store-')), storeRoot = resolve(root, 'custom-sessions'), settingsPath = resolve(root, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: false, maxDiskBytes: 2097152, maxCaptureBytes: 1 } } }))
  const backend = createJsonlBackend(storeRoot), coordinator = createSessionCoordinator(backend, { lock: { enabled: true, lockRoot: resolve(root, 'different-lock-root') } })
  const { id } = await coordinator.create()
  let sends = 0, bodies = 0
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, contextOutputSettingsPath: settingsPath,
    model: controlledModel(async function* () {
      if (++sends === 1) yield { type: 'tool_call', call: { id: 'actual', name: 'large', args: {} } }
      else yield { type: 'text/chunk', text: 'complete' }
      yield { type: 'end' }
    }), additionalTools: [{ name: 'large', description: 'large fixture', inputSchema: {}, isReadOnly: true, async execute() { bodies++; return 'x'.repeat(1_048_576) } }] })
  try {
    await assembly.agent.run('retain the result')
    const result = assembly.session.events.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' ? result.envelope?.retention.kind : undefined).toBe('artifact')
    if (result?.type !== 'tool/result' || result.envelope?.retention.kind !== 'artifact') throw new Error('Expected managed artifact result')
    expect(result.envelope.execution.outcome).toBe('succeeded')
    expect(result.envelope.retention.ref.encodedBytes).toBe(1_048_578)
    expect(bodies).toBe(1)
  } finally { await assembly.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
