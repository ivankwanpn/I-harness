import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { managedExecutionStatus } from '../src/coordinator/managed-document.ts'
import { observeColdExecutionWrites } from '../src/coordinator/cold-execution-writes.ts'

it('publishes actual installed managed code facts after observation, but not unrelated facts', async () => {
 const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'managed-exec-feed-'))
 const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
 try {
  await c.create({sessionId:'s'}); const doc = await c.openManagedDocument('s'); const action = doc.beginAction()
  const seen: string[] = []; const off = observeColdExecutionWrites(c, () => { seen.push(doc.view.events.at(-1)?.type ?? 'missing') })
  await action.facts.metadata.admit({type:'plan/mode',mode:'off'}); expect(seen).toEqual([])
  const result = await action.facts.code.record({type:'code/cell',cellId:'x',state:'started'})
  expect(result.kind).toBe('committed'); expect(seen).toEqual(['code/cell'])
  off(); action.finish()
 } finally { await c.close(); await rm(root,{recursive:true,force:true}) }
})

it('reports passive original managed availability and invalidates at revoke', async () => {
 const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'managed-status-'))
 const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
 try {
  await c.create({sessionId:'s'}); const doc = await c.openManagedDocument('s')
  const seen: string[] = []; const off = observeColdExecutionWrites(c, () => seen.push(managedExecutionStatus(doc)))
  expect(managedExecutionStatus(doc)).toBe('available')
  doc.revokeNewWork()
  expect(managedExecutionStatus(doc)).toBe('retired'); expect(seen).toEqual(['retired'])
  off()
 } finally { await c.close(); await rm(root,{recursive:true,force:true}) }
})

it('invalidates on real transition-owned recovery while passive snapshot stays silent', async () => {
 const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'load-exec-feed-'))
 const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
 try {
  await c.create({sessionId:'s'}); await c.append('s',[{type:'turn/start'},{type:'code/cell',cellId:'x',state:'started'}])
  const seen: string[] = []; const off = observeColdExecutionWrites(c, id => seen.push(id))
  const before = await c.snapshot!('s'); expect(seen).toEqual([])
  await c.load('s'); expect(seen).toContain('s')
  const after = await c.snapshot!('s')
  expect(after.session.events.filter(event => event.type === 'code/cell')).toEqual(before.session.events.filter(event => event.type === 'code/cell'))
  off()
 } finally { await c.close(); await rm(root,{recursive:true,force:true}) }
})

it('reports unresolved original write and restores only after reconcile bookkeeping', async () => {
 const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'managed-reconcile-status-'))
 const backend = createJsonlBackend(root)
 const c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
 try {
  await c.create({sessionId:'s'}); const doc = await c.openManagedDocument('s')
  const original = backend.appendOwnedBatch!; backend.appendOwnedBatch = async (...args) => { await original(...args); return {kind:'unknown', key:args[3].key} }
  const seen: string[] = []; const off = observeColdExecutionWrites(c, () => seen.push(managedExecutionStatus(doc)))
  const result = await doc.metadata.admit({type:'plan/mode',mode:'on'})
  expect(result.kind).toBe('unknown'); expect(seen).toEqual(['unavailable'])
  if (result.kind !== 'unknown') throw Error('unknown required')
  backend.appendOwnedBatch = original
  expect((await doc.reconcile(result.key)).kind).toBe('committed')
  expect(seen).toEqual(['unavailable','available']); expect(managedExecutionStatus(doc)).toBe('available')
  off()
 } finally { await c.close(); await rm(root,{recursive:true,force:true}) }
})

it('keeps a healthy issued write distinct from a recovery fault', async () => {
 const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'managed-inflight-'))
 const backend = createJsonlBackend(root), c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
 try {
  await c.create({sessionId:'s'}); const doc = await c.openManagedDocument('s')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), original = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  const seen: string[] = []; const off = observeColdExecutionWrites(c, () => seen.push(managedExecutionStatus(doc)))
  const work = doc.metadata.admit({type:'plan/mode',mode:'off'}); await entered.promise
  expect(managedExecutionStatus(doc)).toBe('available'); expect(seen).toEqual([])
  release.resolve(); expect((await work).kind).toBe('committed'); expect(seen).toEqual([])
  off()
 } finally { await c.close(); await rm(root,{recursive:true,force:true}) }
})
