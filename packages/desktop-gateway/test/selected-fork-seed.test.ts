import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codecRef } from '../../core-session/test/fixtures/selected-results.ts'
import { createCommitCoordinator } from '../../session-persistence/src/commit/coordinator.ts'
import { asSessionCoordinator } from '../../session-persistence/src/commit/facade.ts'
import { captureSelectedResultsSeed, createSelectedForkController } from '../src/selected-fork.ts'

it('builds the selected-results seed from a commit-log session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gw-selected-seed-'))
  const coordinator = createCommitCoordinator({ root })
  try {
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
    const captured = await captureSelectedResultsSeed(session, 's1')
    expect(captured.kind).toBe('compiled')
    if (captured.kind !== 'compiled') throw new Error(JSON.stringify(captured))
    expect(captured.compiled.records[0]).toMatchObject({ type: 'conversation/seed-manifest', version: 3, codec: 'semantic-seed-v3' })
    expect(captured.compiled.dependencyDigest).toMatch(/^[a-f0-9]{64}$/)
  } finally {
    await coordinator.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
it('prepares and executes a selected-results fork on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gw-selected-fork-'))
  const coordinator = createCommitCoordinator({ root })
  try {
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
    const controller = createSelectedForkController({ coordinator: session })
    const prepared = await controller.prepare({ version: 2, sourceSessionId: 's1', results: 'selected-results-v1' } as never)
    expect(prepared.kind).toBe('prepared')
    if (prepared.kind !== 'prepared') throw new Error(JSON.stringify(prepared))
    const operation = {
      version: 2, kind: 'session-fork-operation', prepared: prepared.prepared,
      invocation: { version: 1, operationId: 'selected-op', targetSessionId: 'child', createdAt: '2026-11-06T00:00:00.000Z', requestDigest: prepared.prepared.requestDigest },
    }
    const outcome = await controller.execute({ operation, mode: 'begin' } as never)
    expect(outcome).toMatchObject({ version: 2, kind: 'ready', sessionId: 'child', capture: 'captured' })
    const child = await session.load('child')
    expect((child.session.header as { semanticSeed?: { version?: number } }).semanticSeed).toMatchObject({ version: 3, codec: 'semantic-seed-v3' })
  } finally {
    await coordinator.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
it('captures selected result pages when the source references a result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gw-selected-pages-'))
  const coordinator = createCommitCoordinator({ root })
  try {
    const session = asSessionCoordinator(coordinator)
    await session.create({ sessionId: 's1' })
    await session.append('s1', [
      { type: 'turn/start' }, { type: 'step/start' },
      { type: 'tool/call', callId: 'c', name: 'read', args: {} },
      { type: 'assistant/message', text: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { type: 'tool/dispatch', callId: 'c', eventSeq: 2 },
      { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: { ...codecRef } } } },
      { type: 'context/result-ref', ref: { id: codecRef.id, workspaceId: 'w', sessionId: 's1', callId: 'c', label: 'read', revision: codecRef.revision, bytes: 12, originalBytes: 12, complete: true, expiresAt: 0 } },
      { type: 'step/end' }, { type: 'turn/end' },
    ] as never)
    const captured = await captureSelectedResultsSeed(session, 's1')
    expect(captured.kind).toBe('compiled')
    if (captured.kind !== 'compiled') throw new Error(JSON.stringify(captured))
    const pages = captured.compiled.records.filter(record => record.type === 'conversation/seed-results')
    expect(pages.length).toBeGreaterThan(0)
  } finally {
    await coordinator.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
it('captures a seed from a selected child (nested)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gw-selected-nested-'))
  const coordinator = createCommitCoordinator({ root })
  try {
    const session = asSessionCoordinator(coordinator)
    await session.create({ sessionId: 's1' })
    await session.append('s1', [
      { type: 'turn/start' }, { type: 'step/start' },
      { type: 'tool/call', callId: 'c', name: 'read', args: {} },
      { type: 'assistant/message', text: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { type: 'tool/dispatch', callId: 'c', eventSeq: 2 },
      { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: { ...codecRef } } } },
      { type: 'context/result-ref', ref: { id: codecRef.id, workspaceId: 'w', sessionId: 's1', callId: 'c', label: 'read', revision: codecRef.revision, bytes: 12, originalBytes: 12, complete: true, expiresAt: 0 } },
      { type: 'step/end' }, { type: 'turn/end' },
    ] as never)
    const captured = await captureSelectedResultsSeed(session, 's1')
    expect(captured.kind).toBe('compiled')
    if (captured.kind !== 'compiled') throw new Error(JSON.stringify(captured))
    await coordinator.createChildSession({
      invocation: { version: 1, operationId: 'nested-op', targetSessionId: 'child', createdAt: '2026-11-06T00:00:00.000Z', requestDigest: 'd'.repeat(64) },
      target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 's1' }, seed: captured.compiled,
    } as never, { closure: captured.compiled.dependencyDigest })
    const nested = await captureSelectedResultsSeed(session, 'child')
    expect(nested.kind).toBe('compiled')
    if (nested.kind !== 'compiled') throw new Error(JSON.stringify(nested))
    expect(nested.compiled.records[0]).toMatchObject({ type: 'conversation/seed-manifest', version: 3 })
  } finally {
    await coordinator.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
