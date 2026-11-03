import { expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs, createNondurableFactOwner, createSession, type CapturedSettlementFact, type ProducerFactOutcome, type SettlementFacts } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'

it.each(['managed', 'nondurable'] as const)('rejects optional facts and accessor discriminators at every required source constructor before lowering (%s)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-required-port-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const owner = mode === 'managed' ? document : createNondurableFactOwner(createSession())
  const action = owner.beginAction(), source = action.registerSettlementSource(async () => {})
  const before = await readFile(join(root, `${id}.jsonl`))
  let lowerings = 0, accessors = 0, writes = 0, traps = 0
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { writes++; return actual(...args) }
  const call = { type: 'tool/call', callId: 'never', name: 'never', args: { toJSON() { lowerings++; return {} } } }
  const store = { type: 'code/store', version: 1, cellId: 'never', writes: [['key', 7]] }
  const rows: { name: string; port(source: SettlementFacts<ProducerFactOutcome>): (...args: never[]) => unknown; event: unknown }[] = [
    { name: 'tools.result/call', port: s => s.tools.result, event: call },
    { name: 'tools.captureResult/call', port: s => s.tools.captureResult, event: call },
    { name: 'code.record/call', port: s => s.code.record, event: { type: 'code/call' } },
    { name: 'code.capture/dispatch', port: s => s.code.capture, event: { type: 'code/dispatch' } },
    { name: 'code.record/store', port: s => s.code.record, event: store },
    { name: 'code.capture/store', port: s => s.code.capture, event: store },
    { name: 'code.record/started', port: s => s.code.record, event: { type: 'code/cell', state: 'started' } },
    { name: 'code.capture/running', port: s => s.code.capture, event: { type: 'code/cell', state: 'running' } },
    { name: 'delivery.record/start', port: s => s.delivery.record, event: { type: 'subagent/start' } },
    { name: 'delivery.capture/start', port: s => s.delivery.capture, event: { type: 'subagent/start' } },
    { name: 'rewind.capture/reset', port: s => s.rewind.capture, event: { type: 'compaction/reset' } },
    { name: 'retention.capture/metadata', port: s => s.retention.capture, event: { type: 'session/title' } },
    { name: 'lifecycle/start', port: s => s.lifecycle.lifecycle, event: { type: 'turn/start' } },
    { name: 'lifecycle/usage-cast', port: s => s.lifecycle.usage, event: { type: 'context/budget' } },
    { name: 'lifecycle/audit-cast', port: s => s.lifecycle.auditAssistant, event: { type: 'user/message' } },
    { name: 'type/accessor', port: s => s.tools.captureResult, event: { get type() { accessors++; return 'tool/result' } } },
    { name: 'state/accessor', port: s => s.code.capture, event: { type: 'code/cell', get state() { accessors++; return 'completed' } } },
    { name: 'reference/accessor', port: s => s.retention.capture, event: { type: 'context/result-ref', ref: { get id() { accessors++; return 'untrusted' } } } },
    { name: 'reference/proxy', port: s => s.retention.capture, event: { type: 'context/result-ref', ref: new Proxy({ id: 'untrusted' }, { getPrototypeOf(target) { traps++; return Reflect.getPrototypeOf(target) } }) } },
  ]
  try {
    for (const row of rows) {
      const returned = Reflect.apply(row.port(source), undefined, [row.event])
      const outcome = returned && typeof returned === 'object' && 'admit' in returned
        ? await (returned as CapturedSettlementFact<ProducerFactOutcome>).admit() : await returned
      expect(outcome, row.name).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
    }
    expect([lowerings, accessors, writes, traps]).toEqual([0, 0, 0, 0])
    expect(owner.view.events).toEqual([])
    expect(await readFile(join(root, `${id}.jsonl`))).toEqual(before)
    const positive = await source.tools.captureResult({ type: 'tool/result', callId: 'actual', name: 'actual', output: { toJSON() { lowerings++; return { z: 7, a: 2 } } } }).admit()
    expect(positive.kind).toBe(mode === 'managed' ? 'committed' : 'memory-committed')
    expect(committedFactSeqs(positive)).toEqual([0])
    committedFactSeqs(await source.code.capture({ type: 'code/output', cellId: 'actual', content: { type: 'text', text: 'actual output' } }).admit())
    committedFactSeqs(await source.code.record({ type: 'code/cell', cellId: 'actual', state: 'completed' }))
    committedFactSeqs(await source.delivery.record({ type: 'subagent/end', version: 1, taskId: 'actual', outcome: 'completed', resultText: 'actual result' }))
    committedFactSeqs(await source.lifecycle.lifecycle({ type: 'turn/end' }))
    expect(owner.view.events.map(event => event.type)).toEqual(['tool/result', 'code/output', 'code/cell', 'subagent/end', 'turn/end'])
    expect(owner.view.events[0]).toMatchObject({ output: { z: 7, a: 2 } })
    expect(lowerings).toBe(1)
    if (mode === 'nondurable') expect(positive).toMatchObject({ durability: 'nondurable' })
  } finally { action.finish(); await coordinator.close().catch(() => {}) }
})
