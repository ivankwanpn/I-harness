import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '@i-harness/context-output'
import { registerCodeMode } from '@i-harness/code-mode'
import type { CodeModeTextRetention } from '@i-harness/code-mode'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import { createCodeModeRuntime } from '@i-harness/code-mode'
import { createCodeTextRetention } from '../src/lifecycle/code-text-retention.ts'
import { PNG } from '../../image-validation/test/fixtures.ts'
import { createSessionService, createDurableSessionLoader } from '../src/index.ts'
import { controlledModel } from './controlled-model.ts'

/** Independent page reader: the expected text is a literal fixture, never the
 * product serializer's own output. */
async function readArtifact(service: ReturnType<typeof createContextOutputService>, sessionId: string, ref: ManagedArtifactRef) {
  const pieces: Buffer[] = []
  let offset = 0
  for (;;) {
    const page = await service.readResult({ sessionId }, { ref, offset })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768)
    pieces.push(page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64'))
    if (page.eof) break
    offset = page.nextOffset!
  }
  return Buffer.concat(pieces)
}

it('captures every accepted item once and reads the exact retained text after the guest exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-a3-code-output-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: join(root, 'context'), workspaceId: 'fixture', config: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'only' },
    retainText: createCodeTextRetention({ service, sessionId: id }) })
  // Independent literal fixture: quotes, backslash, NUL, emoji and an unpaired
  // surrogate must survive the JSON artifact encoding unchanged.
  const first = 'quote" backslash\\ nul\u0000 emoji😀 lone\ud800 '
  const second = 'second segment ' + '段'.repeat(9000)
  const expected = first + '\n' + second
  const code = 'text(' + JSON.stringify(first) + '); image(' + JSON.stringify('data:image/png;base64,' + PNG) + '); text(' + JSON.stringify(second) + ');'
  try {
    const observation = (await tools.execute({ name: 'code_exec', args: { code } })).output as { status: string; text: string; items: { type: string }[]; textRetention: CodeModeTextRetention }
    expect(observation.status).toBe('completed')
    // Item order is preserved: text, image, text.
    expect(observation.items.map(item => item.type)).toEqual(['text', 'image', 'text'])
    // The model/archive window stays bounded.
    expect(Buffer.byteLength(observation.text)).toBeLessThanOrEqual(16 * 1024)
    expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThanOrEqual(64_000)
    const retention = observation.textRetention
    expect(retention).toMatchObject({ stored: true, complete: true, admittedBytes: Buffer.byteLength(expected) })
    const ref = retention.envelope?.retention.kind === 'artifact' ? retention.envelope.retention.ref : undefined
    expect(ref).toMatchObject({ codec: 'json-utf8-v1', completeness: 'complete' })
    // Every accepted item was captured once as its own original code fact.
    expect(document.view.events.filter(event => event.type === 'code/output')).toHaveLength(3)
    expect(document.view.events.filter(event => event.type === 'context/result-ref')).toEqual([])
    const body = await readArtifact(service, id, ref!)
    expect(createHash('sha256').update(body).digest('hex')).toBe(ref!.contentDigest)
    expect(body.length).toBe(ref!.encodedBytes)
    expect(retention.representation).toBe('code-text-index-v1')
    const index = JSON.parse(body.toString('utf8'))
    expect(index.kind).toBe('code-text-index')
    expect(index.items.map((item: { type: string }) => item.type)).toEqual(['text', 'image', 'text'])
    const texts = []
    for (const item of index.items) if (item.type === 'text') texts.push(JSON.parse((await readArtifact(service, id, item.envelope.retention.ref)).toString('utf8')))
    expect(texts).toEqual([first, second])
    expect(texts.join('\n')).toBe(expected)
    expect(JSON.stringify(document.view.events.filter(event => event.type === 'code/output'))).not.toContain(second)
    expect(retention.envelope?.preview).toBe('')
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await service.close(); await ctx.scope.unmount() }
})

it('recovers an unknown artifact finish through the same original operation without a second guest run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-a3-code-unknown-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create()
  await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: join(root, 'context'), workspaceId: 'fixture', config: { enabled: true } })
  const begin = service.beginResult.bind(service)
  let finishes = 0, writes = 0, committed: ManagedArtifactRef | undefined
  service.beginResult = async (scope, codec) => {
    const sink = await begin(scope, codec)
    return { ...sink,
      async write(bytes) { writes++; return sink.write(bytes) },
      async finish(completeness) {
        finishes++
        // The first finish has an unknown receipt; the retry reconciles the
        // same original operation and returns its committed reference.
        if (finishes === 1) return { kind: 'recovery-required' as const, operationId: 'original' }
        const settled = await sink.finish(completeness)
        if (settled.kind === 'committed') committed = settled.ref
        return settled
      },
    }
  }
  let invokes = 0
  const runtime = createCodeModeRuntime({ tools: () => [], invoke: async () => { invokes++; return null }, retentionRecovery: () => {},
    retainText: createCodeTextRetention({ service, sessionId: id }) })
  const text = 'unknown receipt body ' + 'x'.repeat(20000)
  try {
    await expect(runtime.exec({ code: 'text(' + JSON.stringify(text) + ');' }, { sessionId: id })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(invokes).toBe(0)
    // Same capture/operation settles after the receipt is resolved.
    await runtime.drainRetainedObservations?.()
    expect(finishes).toBe(2)
    expect(committed).toBeDefined()
    const body = await readArtifact(service, id, committed!)
    expect(JSON.parse(body.toString('utf8'))).toBe(text)
    expect(writes).toBeGreaterThan(0)
  } finally { await runtime.dispose().catch(() => {}) ; await coordinator.close().catch(() => {}); await service.close() }
})

it('binds the emitted-text artifact to the acting child document, never a parent grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-a3-child-scope-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const parentId = (await coordinator.create()).id, childId = (await coordinator.create()).id
  const parent = await coordinator.openManagedDocument(parentId), child = await coordinator.openManagedDocument(childId)
  const service = createContextOutputService({ root: join(root, 'context'), workspaceId: 'fixture', config: { enabled: true },
    authorizeResult: async access => access.sessionId === childId })
  let runtime: ReturnType<typeof createCodeModeRuntime> | undefined
  try {
    runtime = createCodeModeRuntime({ tools: () => [], invoke: async () => null, retainText: createCodeTextRetention({ service, sessionId: childId }) })
    const observation = await runtime.exec({ code: 'text(' + JSON.stringify('child emitted ' + 'y'.repeat(20000)) + ');' }, { sessionId: childId })
    const ref = observation.textRetention?.envelope?.retention.kind === 'artifact' ? observation.textRetention.envelope.retention.ref : undefined
    expect(ref).toBeDefined()
    expect(observation.textRetention).toMatchObject({ stored: true, sessionId: childId })
    expect(JSON.parse((await readArtifact(service, childId, ref!)).toString('utf8'))).toContain('child emitted')
    await expect(service.readResult({ sessionId: parentId }, { ref: ref! })).rejects.toThrow()
    expect(child.view.events.filter(event => event.type === 'context/result-ref')).toEqual([])
    expect(parent.view.events).toEqual([])
  } finally { await runtime?.dispose().catch(() => {}); await parent.close().catch(() => {}); await child.close().catch(() => {}); await coordinator.close().catch(() => {}); await service.close() }
})

it('uses the actual restricted child assembly mount and preserves its own durable output authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-a3-role-child-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const output = createContextOutputService({ root: join(root, 'results'), workspaceId: 'fixture', config: { enabled: false } })
  let requests = 0
  const child = controlledModel(async function* () {
    if (++requests === 1) yield { type: 'tool_call', call: { id: 'child-code', name: 'code_exec', args: { code: 'text(ALL_TOOLS.map(t=>t.name)); text("child-owned".repeat(3000));', yield_time_ms: 5000 } } }
    else yield { type: 'text/chunk', text: 'child complete' }
    yield { type: 'end' }
  })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutput: output,
    modelPolicy: 'test-mock', sandbox: 'danger-full-access', codeMode: { mode: 'only' }, contextWindow: 100000,
    pluginAgents: [{ name: 'probe', description: 'restricted test role', systemPrompt: 'Use only your role tools', tools: ['list_dir', 'code_exec', 'code_wait'] }],
    additionalTools: [{ name: 'parent_secret', description: '', inputSchema: {}, execute: async () => { throw new Error('Child must not call parent-only tools') } }],
    allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: 'fixture', model: 'child' }),
    resolveRoleModel: async () => ({ status: 'ready', binding: { client: child, contextWindow: 100000 } }),
  })
  try {
    const assembly = await service.assemblyFor('parent')
    await assembly.tools.get('spawn_agent')!.execute({ task_name: 'probe', agent_type: 'probe', message: 'emit once', fork_turns: 'none', background: false }, { sessionId: 'parent' })
    const rows = await assembly.tools.get('list_agents')!.execute({}, { sessionId: 'parent' }) as { agents: { path: string; sessionId: string }[] }
    const id = rows.agents.find(row => row.path === 'root/probe')!.sessionId
    const events = (await coordinator.snapshot!(id)).session.events
    const outputs = events.filter(event => event.type === 'code/output')
    expect(outputs).toHaveLength(2)
    expect(outputs[0]!.envelope?.preview).toBe('["list_dir"]')
    const ref = outputs[1]!.envelope?.retention.kind === 'artifact' ? outputs[1]!.envelope.retention.ref : undefined
    expect(ref).toBeDefined()
    expect(JSON.parse((await readArtifact(output, id, ref!)).toString('utf8'))).toBe('child-owned'.repeat(3000))
    await expect(output.readResult({ sessionId: 'parent' }, { ref: ref! })).rejects.toThrow()
    expect(assembly.session.events.some(event => event.type === 'code/output')).toBe(false)
    expect(requests).toBe(2)
  } finally { await service.close(); await coordinator.close(); await output.close() }
}, 20000)
