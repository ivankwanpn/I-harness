import { mkdtemp, rm, appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlBackend, lookupJsonlProcessRead } from '../src/backend-factory.ts'
import { createSessionCoordinator } from './helpers/composed.ts'
import { createPredecessorSession } from './helpers/predecessor.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { issueHeldTaskDocumentScope } from '../../session-persistence/src/coordinator/task-document-scope.ts'
import { encodeFactBatch, readFactJournal, type SessionEvent } from '@i-harness/core-session'

it('keeps an ordinary caller-supplied clean check outside native history qualification', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-history-check-'))
  const backend = createJsonlBackend(root), owner = createOwnership(backend, { lock: { enabled: true } })
  const pin = await owner.pinOwnership('p'), lease = await owner.acquireLease('doc:task-p')
  const scope = issueHeldTaskDocumentScope(owner, 'p', pin, { assertActive() { if (!lease.held) throw Error('revoked') } })
  const capability = lookupJsonlProcessRead(backend)!
  const reader = capability.openTaskHistory(scope, undefined, { async before() {}, isCanonical: () => true })
  try {
    await backend.create('p', { formatVersion: 14, sessionId: 'p', createdAt: 'fixture' })
    const proof = await reader.observeClean()
    expect(proof?.initial.events).toEqual([])
    expect(capability.recognizesCleanHistoryMaterialization(proof!)).toBe(false)
  } finally { await reader.settleResources(); await lease.release(); await pin.release(); await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('preserves ordinary clean decode failures with a duplicate fence and a later invalid frame (%s)', async corruptSuffix => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-history-invalid-'))
  const create = () => createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const seed = create()
  try { await seed.create({ sessionId: 'p' }) } finally { await seed.close() }
  const path = join(root, 'p.jsonl'), header = await readFile(path), metadata = JSON.parse(header.toString()).journal
  const duplicate = encodeFactBatch('duplicate', metadata.legacyPrefixDigest, [
    { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 0 },
    { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 1 },
  ])
  const bytes = Buffer.concat([header, duplicate.bytes, Buffer.from(corruptSuffix ? 'invalid\n' : '')])
  await writeFile(path, bytes)
  async function rejected(replacedParser: boolean) {
    const coordinator = create()
    const parse = replacedParser ? vi.spyOn(JSON, 'parse') : undefined
    try {
      const result = await coordinator.loadOwned('p').then(() => undefined, error => error)
      expect(result).toBeInstanceOf(Error)
      const reasons: { code?: string; message: string }[] = []
      for (let e = result; e instanceof Error; e = e.cause)
        reasons.push({ message: e.message, code: (e as Error & { code?: string }).code })
      return reasons
    } finally { parse?.mockRestore(); await coordinator.close() }
  }
  try {
    const baseline = await rejected(true)
    expect(baseline.at(-1)?.message).toMatch(corruptSuffix ? /Invalid fact journal frame/ : /duplicate semantics fence/)
    expect(await rejected(false)).toEqual(baseline)
    expect(await readFile(path)).toEqual(bytes)
  } finally { await rm(root, { recursive: true, force: true }) }
})

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

it('applies registration and operational DTO checks after managed journal validation', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-history-format-'))
  const backend = createJsonlBackend(root)
  const owner = createOwnership(backend, { lock: { enabled: true } })
  const pin = await owner.pinOwnership('p')
  const lease = await owner.acquireLease('doc:task-p')
  const scope = issueHeldTaskDocumentScope(owner, 'p', pin, { assertActive() { if (!lease.held) throw Error('revoked') } })
  try {
    const path = await createPredecessorSession(backend, root, 'p', 13)
    const header = await readFile(path)
    const meta = JSON.parse(header.toString('utf8'))
    const cases = [
      { event: { type: 'future/fixture', seq: 0 }, rejection: /unknown event type/ },
      { event: { type: 'future/fixture', seq: 0, ignorable: true } },
      { event: { type: 'context/budget', seq: 0, version: 1, snapshot: {} }, rejection: /unsupported operational payload/ },
    ]
    for (const { event, rejection } of cases) {
      const frame = encodeFactBatch('fixture', meta.journal.legacyPrefixDigest, [event as unknown as SessionEvent])
      // These cases pass conversation validation and exercise the separate persistence gate.
      expect(readFactJournal(frame.bytes, meta.journal, meta.formatVersion, meta).events).toEqual([event])
      await writeFile(path, Buffer.concat([header, frame.bytes]))
      const reader = lookupJsonlProcessRead(backend)!.openTaskHistory(scope)
      try {
        if (rejection) await expect(reader.observe()).rejects.toThrow(rejection)
        else expect((await reader.observe()).initial.events).toEqual([event])
      } finally { await reader.settleResources() }
    }
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
