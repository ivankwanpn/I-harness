import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codecRef } from '../../core-session/test/fixtures/selected-results.ts'
import { createCommitCoordinator } from '../../session-persistence/src/commit/coordinator.ts'
import { asSessionCoordinator } from '../../session-persistence/src/commit/facade.ts'
import { captureSelectedResultsSeed, createSelectedForkController } from '../src/selected-fork.ts'

// This file owns the codec/controller level: it proves the exact seed metadata
// the fork hands to a child and the controller's own write path. Body reads,
// source retirement and cold replay need a real artifact owner and are covered
// by host-commit-log-selected-fork.test.ts and host-commit-log-selected-read.test.ts.
// The artifact reference below is therefore a synthetic, explicitly shaped
// identity: only metadata projection is under test here.
const legacyRef = {
  id: 'ctx_' + 'b'.repeat(64), workspaceId: 'workspace', sessionId: 's1', callId: 'c', label: 'read',
  revision: 'b'.repeat(64), bytes: 12, originalBytes: 12, complete: true, expiresAt: 4_102_444_800_000,
}

async function savedResultFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-gw-selected-seed-'))
  const coordinator = createCommitCoordinator({ root })
  const session = asSessionCoordinator(coordinator)
  await session.create({ sessionId: 's1' })
  await session.append('s1', [
    { type: 'turn/start' }, { type: 'step/start' },
    { type: 'tool/call', callId: 'c', name: 'read', args: {} },
    { type: 'assistant/message', text: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
    { type: 'tool/dispatch', callId: 'c', eventSeq: 2 },
    { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: { ...codecRef } } } },
    { type: 'step/end' }, { type: 'turn/end' },
  ] as never)
  const loaded = await session.load('s1')
  const resultSeq = (loaded.session.events as { type: string; seq?: number }[]).find(event => event.type === 'tool/result')!.seq!
  return { root, coordinator, session, resultSeq, close: async () => { await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) } }
}

it('compiles the exact selected-results seed metadata from a commit-log session', async () => {
  const fixture = await savedResultFixture()
  try {
    const captured = await captureSelectedResultsSeed(fixture.session, 's1')
    expect(captured.kind).toBe('compiled')
    if (captured.kind !== 'compiled') throw new Error(JSON.stringify(captured))
    expect(captured.compiled.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(captured.compiled.dependencyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(captured.compiled.sourceObservation).toMatchObject({ kind: 'semantic', digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const [manifest, page] = captured.compiled.records as unknown as [{ type: string; version: number; codec: string; results: unknown; resultPageCount: number }, { type: string; version: number; manifestSeq: number; ordinal: number; page: { rows: { protocol: string; ref: unknown; original: unknown }[] } }]
    expect(manifest).toMatchObject({ type: 'conversation/seed-manifest', version: 3, codec: 'semantic-seed-v3', resultPageCount: 1,
      results: { version: 1, rows: 1, pages: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect(page).toMatchObject({ type: 'conversation/seed-results', version: 1, manifestSeq: 0, ordinal: 0 })
    expect(page.page.rows).toHaveLength(1)
    // The saved reference and its original event address are carried verbatim.
    expect(page.page.rows[0]!.protocol).toBe('managed')
    expect(page.page.rows[0]!.ref).toEqual(codecRef)
    expect(page.page.rows[0]!.original).toEqual({ kind: 'local', sessionId: 's1', seq: fixture.resultSeq, event: 'tool/result', slot: 'envelope.retention.ref' })
  } finally { await fixture.close() }
}, 30000)

it('prepares and executes a selected-results fork on the commit log and retains its managed refs for the target', async () => {
  const fixture = await savedResultFixture()
  const grantCalls: { access: { sessionId: string }; ids: string[]; target: string }[] = []
  try {
    const captured = await captureSelectedResultsSeed(fixture.session, 's1')
    if (captured.kind !== 'compiled') throw new Error(JSON.stringify(captured))
    const controller = createSelectedForkController({ coordinator: fixture.session,
      contextOutput: { async grant(access, ids, target) { grantCalls.push({ access, ids: [...ids], target }) } } })
    const prepared = await controller.prepare({ version: 2, sourceSessionId: 's1', results: 'selected-results-v1' } as never)
    expect(prepared.kind).toBe('prepared')
    if (prepared.kind !== 'prepared') throw new Error(JSON.stringify(prepared))
    const operation = {
      version: 2, kind: 'session-fork-operation', prepared: prepared.prepared,
      invocation: { version: 1, operationId: 'selected-op', targetSessionId: 'child', createdAt: '2026-11-06T00:00:00.000Z', requestDigest: prepared.prepared.requestDigest },
    }
    const outcome = await controller.execute({ operation, mode: 'begin' } as never)
    expect(outcome).toMatchObject({ version: 2, kind: 'ready', sessionId: 'child', capture: 'captured' })
    if (!('receipt' in outcome)) throw new Error(JSON.stringify(outcome))
    // The receipt is the compiled seed, not a second derivation.
    expect(outcome.receipt.seedDigest).toBe(captured.compiled.digest)
    expect(outcome.receipt.dependencyClosureDigest).toBe(captured.compiled.dependencyDigest)
    expect(outcome.seedLength).toBe(captured.compiled.records.length)
    expect(outcome.receipt.results).toEqual((captured.compiled.records[0] as { results: unknown }).results)
    // Target retention is published for exactly the inherited managed refs.
    expect(grantCalls).toEqual([{ access: { sessionId: 's1' }, ids: [codecRef.id], target: 'child' }])

    const child = await fixture.session.load('child')
    expect((child.session.header as { semanticSeed?: { version?: number; codec?: string } }).semanticSeed).toMatchObject({ version: 3, codec: 'semantic-seed-v3' })

    // Retrying the same operation adopts the durable child and re-publishes the
    // same retention without a second seed write.
    const retried = await controller.execute({ operation, mode: 'retry' } as never)
    expect(retried).toMatchObject({ kind: 'ready', sessionId: 'child' })
    if (!('receipt' in retried)) throw new Error(JSON.stringify(retried))
    expect(retried.receipt).toEqual(outcome.receipt)
    expect(grantCalls).toHaveLength(2)
    expect(grantCalls[1]).toEqual(grantCalls[0])
  } finally { await fixture.close() }
}, 60000)

it('reports no ready target when managed retention cannot be published', async () => {
  const fixture = await savedResultFixture()
  try {
    const controller = createSelectedForkController({ coordinator: fixture.session,
      contextOutput: { async grant() { throw new Error('target retention refused') } } })
    const prepared = await controller.prepare({ version: 2, sourceSessionId: 's1', results: 'selected-results-v1' } as never)
    if (prepared.kind !== 'prepared') throw new Error(JSON.stringify(prepared))
    const operation = {
      version: 2, kind: 'session-fork-operation', prepared: prepared.prepared,
      invocation: { version: 1, operationId: 'selected-retention-failure', targetSessionId: 'child', createdAt: '2026-11-06T00:00:00.000Z', requestDigest: prepared.prepared.requestDigest },
    }
    // A failed grant must not be acknowledged as a ready selection: callers
    // retry the same operation instead of trusting a target without retention.
    await expect(controller.execute({ operation, mode: 'begin' } as never)).rejects.toThrow('target retention refused')
  } finally { await fixture.close() }
}, 30000)

it('captures a declared legacy reference as metadata only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gw-selected-legacy-'))
  const coordinator = createCommitCoordinator({ root })
  const session = asSessionCoordinator(coordinator)
  try {
    await session.create({ sessionId: 's1' })
    await session.append('s1', [
      { type: 'turn/start' }, { type: 'step/start' },
      { type: 'tool/call', callId: 'c', name: 'read', args: {} },
      { type: 'assistant/message', text: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { type: 'tool/dispatch', callId: 'c', eventSeq: 2 },
      { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: { ...codecRef } } } },
      { type: 'context/result-ref', ref: { ...legacyRef } },
      { type: 'step/end' }, { type: 'turn/end' },
    ] as never)
    const captured = await captureSelectedResultsSeed(session, 's1')
    if (captured.kind !== 'compiled') throw new Error(JSON.stringify(captured))
    const page = captured.compiled.records[1] as unknown as { page: { rows: { protocol: string; ref: unknown }[] } }
    // Both declared result slots survive as metadata; this file makes no body
    // readability claim for either protocol.
    expect(page.page.rows.find(row => row.protocol === 'legacy')).toMatchObject({ ref: legacyRef })
    expect(page.page.rows.find(row => row.protocol === 'managed')).toMatchObject({ ref: codecRef })
  } finally {
    await coordinator.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('captures a nested selected child with its inherited metadata row', async () => {
  const fixture = await savedResultFixture()
  const grants: string[][] = []
  try {
    const controller = createSelectedForkController({ coordinator: fixture.session,
      contextOutput: { async grant(_access, ids) { grants.push([...ids]) } } })
    const prepared = await controller.prepare({ version: 2, sourceSessionId: 's1', results: 'selected-results-v1' } as never)
    if (prepared.kind !== 'prepared') throw new Error(JSON.stringify(prepared))
    const operation = {
      version: 2, kind: 'session-fork-operation', prepared: prepared.prepared,
      invocation: { version: 1, operationId: 'selected-nested', targetSessionId: 'child', createdAt: '2026-11-06T00:00:00.000Z', requestDigest: prepared.prepared.requestDigest },
    }
    expect((await controller.execute({ operation, mode: 'begin' } as never)).kind).toBe('ready')
    const nested = await captureSelectedResultsSeed(fixture.session, 'child')
    if (nested.kind !== 'compiled') throw new Error(JSON.stringify(nested))
    expect(nested.compiled.records[0]).toMatchObject({ type: 'conversation/seed-manifest', version: 3, resultPageCount: 1 })
    const page = nested.compiled.records[1] as unknown as { page: { rows: { protocol: string; ref: unknown }[] } }
    expect(page.page.rows.map(row => ({ protocol: row.protocol, ref: row.ref }))).toEqual([{ protocol: 'managed', ref: codecRef }])
    expect(grants).toEqual([[codecRef.id]])
  } finally { await fixture.close() }
}, 60000)
