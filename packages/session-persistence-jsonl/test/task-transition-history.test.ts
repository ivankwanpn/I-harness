import { mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend, lookupJsonlProcessRead } from '../src/backend-factory.ts'
import { createPredecessorSession } from './helpers/predecessor.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { issueHeldTaskDocumentScope } from '../../session-persistence/src/coordinator/task-document-scope.ts'

it('captures only the complete original framed parent under its genuine task scope', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-history-'))
  const backend = createJsonlBackend(root), owner = createOwnership(backend, { lock: { enabled: true } })
  const pin = await owner.pinOwnership('parent'), lease = await owner.acquireLease('doc:task-parent')
  const scope = issueHeldTaskDocumentScope(owner, 'parent', pin, { assertActive() { if (!lease.held) throw Error('revoked') } })
  try {
    await createPredecessorSession(backend, root, 'parent', 13, '2026-01-01')
    const capability = lookupJsonlProcessRead(backend)!
    expect(() => capability.openTaskHistory({ ...scope })).toThrow()
    const reader = capability.openTaskHistory(scope); const history = await reader.observe()
    expect(history.initial.events).toEqual([]); expect(history.seedLength).toBe(0)
    await history.assertCurrent()
    await appendFile(join(root, 'parent.jsonl'), '{"torn":')
    await expect(history.assertCurrent()).rejects.toThrow()
    const second = capability.openTaskHistory(scope); await expect(second.observe()).rejects.toThrow(); await second.settleResources(); await reader.settleResources()
  } finally { await lease.release(); await pin.release(); await rm(root, { recursive: true, force: true }) }
})

it('captures a legacy full history and preserves its explicit inherited boundary', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-history-legacy-'))
  const backend = createJsonlBackend(root), owner = createOwnership(backend, { lock: { enabled: true } })
  const pin = await owner.pinOwnership('p'), lease = await owner.acquireLease('doc:task-p')
  const scope = issueHeldTaskDocumentScope(owner, 'p', pin, { assertActive() { if (!lease.held) throw Error('revoked') } })
  const path = join(root, 'p.jsonl')
  const start = (taskId: string) => ({ type: 'subagent/start', version: 1, taskId, agentPath: 'a', role: 'r', description: 'd' })
  try {
    await writeFile(path, [JSON.stringify({ sessionId: 'p', formatVersion: 5, createdAt: 'x', parentSession: 'origin', seedLength: 1 }), JSON.stringify(start('inherited')), JSON.stringify(start('local')), ''].join('\n'))
    const reader = lookupJsonlProcessRead(backend)!.openTaskHistory(scope), history = await reader.observe()
    expect(history.seedLength).toBe(1); expect(history.initial.events).toHaveLength(2); await reader.settleResources()
    await writeFile(path, [JSON.stringify({ sessionId: 'p', formatVersion: 5, createdAt: 'x', parentSession: 'origin' }), JSON.stringify(start('local')), ''].join('\n'))
    const unscoped = lookupJsonlProcessRead(backend)!.openTaskHistory(scope); await expect(unscoped.observe()).rejects.toThrow(); await unscoped.settleResources()
    await writeFile(path, [JSON.stringify({ sessionId: 'p', formatVersion: 5, createdAt: 'x' }), '{bad}', JSON.stringify(start('local')), ''].join('\n'))
    const corrupt = lookupJsonlProcessRead(backend)!.openTaskHistory(scope); await expect(corrupt.observe()).rejects.toThrow(); await corrupt.settleResources()
  } finally { await lease.release(); await pin.release(); await rm(root, { recursive: true, force: true }) }
})

it('retains an exact fresh parent absence under the original task scope', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-parent-absence-'))
  const backend = createJsonlBackend(root), owner = createOwnership(backend, { lock: { enabled: true } })
  const pin = await owner.pinOwnership('p'), lease = await owner.acquireLease('doc:task-p')
  const scope = issueHeldTaskDocumentScope(owner, 'p', pin, { assertActive() { if (!lease.held) throw Error('revoked') } })
  try {
    const capability = lookupJsonlProcessRead(backend)!, absence = await capability.observeFreshTaskParent(scope)
    await absence.assertCurrent()
    await writeFile(join(root, 'p.jsonl'), 'foreign\n')
    await expect(absence.assertCurrent()).rejects.toThrow()
    await expect(capability.observeFreshTaskParent(scope)).rejects.toThrow()
  } finally { await lease.release(); await pin.release(); await rm(root, { recursive: true, force: true }) }
})
