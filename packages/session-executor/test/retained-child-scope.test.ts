import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { decodeFactBatch } from '@i-harness/core-session'
import { contextWorkspaceLocation, contextSourceIdentity } from '@i-harness/context-output'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionAssembly } from '../src/assembly.ts'
import { controlledModel } from './controlled-model.ts'

it('a held real child keeps its launch source, settles original pins after project change, denies reads, and binds a fresh followup source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'held-child-source-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const oldScope = { id: 'old', name: 'old', roots: [root], primaryRoot: root }, newScope = { ...oldScope, id: 'new', name: 'new' }
  let current: typeof oldScope | undefined = oldScope, sends = 0, originalFacts = 0
  const full = 'x'.repeat(1_048_576), location = await contextWorkspaceLocation(root, root)
  const managed = join(location.serviceRoot, 'context-output', createHash('sha256').update(location.workspaceKey).digest('hex'), 'managed-v1')
  const append = backend.appendOwnedBatch!.bind(backend)
  backend.appendOwnedBatch = async (...args) => {
    for (const event of decodeFactBatch(args[3].bytes).events) if (event.type === 'subagent/end' && event.envelope?.retention.kind === 'artifact') {
      originalFacts++
      expect(await readdir(join(managed, event.envelope.retention.ref.id, 'pins'))).toHaveLength(2)
    }
    return append(...args)
  }
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, approveAll: true, projectContext: () => current, model: controlledModel(async function* () {
    const send = ++sends
    if (send === 1) yield { type: 'tool_call', call: { id: 'held-once', name: 'spawn_agent', args: { task_name: 'held', message: 'go', background: false } } }
    else if (send === 2) { held.resolve(); await release.promise; yield { type: 'text/chunk', text: full } }
    else if (send === 4) yield { type: 'tool_call', call: { id: 'followup-once', name: 'followup_task', args: { target: 'root/held', message: 'again' } } }
    else yield { type: 'text/chunk', text: send >= 5 ? full : 'done' }
    yield { type: 'end' }
  }) })
  let turn: Promise<unknown> | undefined
  try {
    turn = assembly.agent.run('launch'); await held.promise
    current = newScope; release.resolve(); await turn
    const first = assembly.subagentState().agentTable[0]!.result!
    if (first.kind !== 'retained' || first.envelope.retention.kind !== 'artifact') throw new Error('Expected retained held result')
    const ref = first.envelope.retention.ref
    const operation = JSON.parse(await readFile(join(managed, ref.id, 'operation.json'), 'utf8'))
    expect(operation.owner.source.sourceId).toBe(contextSourceIdentity(location.workspaceKey, location.canonical, oldScope))
    const read = assembly.tools.get('context_output_read')!
    expect(await read.execute({ ref }, { sessionId: id })).toMatchObject({ kind: 'unavailable', reason: 'unauthorized' })
    current = undefined
    expect(await read.execute({ ref }, { sessionId: id })).toMatchObject({ kind: 'unavailable', reason: 'unauthorized' })
    current = newScope
    await assembly.agent.run('follow up')
    await vi.waitFor(() => expect(assembly.subagentState().agentTable[0]!.result?.revision).not.toBe(first.revision))
    await vi.waitFor(() => expect(assembly.subagentState().agentTable[0]!.result?.kind).toBe('retained'))
    const next = assembly.subagentState().agentTable[0]!.result!
    if (next.kind !== 'retained' || next.envelope.retention.kind !== 'artifact') throw new Error('Expected fresh followup result')
    const nextRef = next.envelope.retention.ref
    expect(JSON.parse(await readFile(join(managed, nextRef.id, 'operation.json'), 'utf8')).owner.source.sourceId).toBe(contextSourceIdentity(location.workspaceKey, location.canonical, newScope))
    expect((await read.execute({ ref: nextRef }, { sessionId: id })) as any).toHaveProperty('data.kind', 'text')
    expect(await readdir(managed)).toHaveLength(2)
    expect(originalFacts).toBe(1); expect(sends).toBe(6)
  } finally { release.resolve(); await turn?.catch(() => {}); await assembly.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
