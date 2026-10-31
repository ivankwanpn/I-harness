import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createTaskDocumentObservation } from '../../session-persistence-jsonl/src/backend/task-document-observation.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createMutations } from '../src/coordinator/mutations.ts'
import { createLoads } from '../src/coordinator/load.ts'
import { createManagedDocuments } from '../src/coordinator/managed-documents.ts'
import { createDocuments } from '../src/coordinator/documents.ts'

it('observes and confirms literal task bytes through actual Documents ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-operation-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } }
  const ownership = createOwnership(backend, opts), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations)
  const managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations)
  const documents = createDocuments(backend, ownership, () => {}, undefined, { captureParent: document => managed.captureParent(document), validator: taskDocumentStorageContract, open: scope => createTaskDocumentObservation(root, join(root, `${scope.key}.doc.jsonl`), scope) })
  try {
    await mutations.create({ sessionId: 'parent' }); const parent = await managed.open('parent')
    const bytes = '{ "formatVersion": 2, "tasks": [], "notifications": [] }\n'; await writeFile(join(root, 'task-parent.doc.jsonl'), bytes)
    const token = documents.taskOperations!.parent(parent), operation = await documents.taskOperations!.begin(token), observed = await operation.observe()
    expect(observed.kind).toBe('present'); if (observed.kind !== 'present') throw new Error('missing')
    expect((await operation.confirm(observed.witness)).kind).toBe('confirmed')
    expect(await operation.confirm(observed.witness)).toEqual(await operation.confirm(observed.witness))
    expect((await parent.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
    expect((await operation.confirm(observed.witness)).kind).toBe('confirmed')
    await documents.putDocumentStrict('task-parent', { formatVersion: 2, tasks: [], notifications: [] })
    await expect(operation.observe()).rejects.toThrow(); await expect(operation.confirm(observed.witness)).rejects.toThrow()
    await operation.close()
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})

it('rejects validator self mutation without invalidating the original operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-self-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } }
  const ownership = createOwnership(backend, opts), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations)
  const managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations)
  let attempted: Promise<void> | undefined
  const documents = createDocuments(backend, ownership, () => {}, undefined, { captureParent: document => managed.captureParent(document), validator: { validate(value) { taskDocumentStorageContract.validate(value); attempted = documents.putDocumentStrict('task-parent', value); void attempted.catch(() => {}) } }, open: scope => createTaskDocumentObservation(root, join(root, `${scope.key}.doc.jsonl`), scope) })
  try {
    await mutations.create({ sessionId: 'parent' }); const parent = await managed.open('parent')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operation = await documents.taskOperations!.begin(documents.taskOperations!.parent(parent)), observed = await operation.observe()
    await expect(attempted).rejects.toThrow(); if (observed.kind !== 'present') throw new Error('missing')
    expect((await operation.confirm(observed.witness)).kind).toBe('confirmed'); await operation.close()
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})

it('registers before a suspended original pin and joins cleanup before a same-key write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-acquire-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } }
  const ownership = createOwnership(backend, opts), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations)
  const managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations)
  const documents = createDocuments(backend, ownership, () => {}, undefined, { captureParent: document => managed.captureParent(document), validator: taskDocumentStorageContract, open: scope => createTaskDocumentObservation(root, join(root, `${scope.key}.doc.jsonl`), scope) })
  try {
    await mutations.create({ sessionId: 'parent' }); const parent = await managed.open('parent'), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const original = ownership.pinOwnership; ownership.pinOwnership = async id => { entered.resolve(); await release.promise; return original(id) }
    const begin = documents.taskOperations!.begin(documents.taskOperations!.parent(parent)); void begin.catch(() => {})
    await entered.promise; let wrote = false
    const write = documents.putDocumentStrict('task-parent', { formatVersion: 2, tasks: [], notifications: [] }).then(() => { wrote = true })
    await Promise.resolve(); expect(wrote).toBe(false); release.resolve()
    await expect(begin).rejects.toThrow('TASK_DOCUMENT_BEGIN_FAILED'); await write; expect(wrote).toBe(true)
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})

it('retains the acquisition record while the original task lease is suspended', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-lease-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } }
  const ownership = createOwnership(backend, opts), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations)
  const managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations)
  const documents = createDocuments(backend, ownership, () => {}, undefined, { captureParent: document => managed.captureParent(document), validator: taskDocumentStorageContract, open: scope => createTaskDocumentObservation(root, join(root, `${scope.key}.doc.jsonl`), scope) })
  try {
    await mutations.create({ sessionId: 'parent' }); const parent = await managed.open('parent'), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const original = ownership.acquireDocumentLease; ownership.acquireDocumentLease = async id => { if (id === 'task-parent') { entered.resolve(); await release.promise }; return original(id) }
    const begin = documents.taskOperations!.begin(documents.taskOperations!.parent(parent)); void begin.catch(() => {})
    await entered.promise; let wrote = false
    const writing = documents.putDocumentStrict('task-parent', { formatVersion: 2, tasks: [], notifications: [] }).then(() => { wrote = true })
    await Promise.resolve(); expect(wrote).toBe(false); release.resolve()
    await expect(begin).rejects.toThrow('TASK_DOCUMENT_BEGIN_FAILED'); await writing; expect(wrote).toBe(true)
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})

it('wraps a falsey failed acquisition and associates cleanup only with its original error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-falsey-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } }
  const ownership = createOwnership(backend, opts), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations)
  const managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations)
  const documents = createDocuments(backend, ownership, () => {}, undefined, { captureParent: document => managed.captureParent(document), validator: taskDocumentStorageContract, open: scope => createTaskDocumentObservation(root, join(root, `${scope.key}.doc.jsonl`), scope) })
  try {
    await mutations.create({ sessionId: 'parent' }); const parent = await managed.open('parent'), token = documents.taskOperations!.parent(parent)
    const original = ownership.pinOwnership; ownership.pinOwnership = async () => { throw null }
    let failure: unknown; try { await documents.taskOperations!.begin(token) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error); expect((failure as Error).cause).toBeNull()
    expect(documents.taskOperations!.cleanupFor(new Error('TASK_DOCUMENT_BEGIN_FAILED'))).toBeUndefined()
    await documents.taskOperations!.cleanupFor(failure)!.retry(); ownership.pinOwnership = original
    const operation = await documents.taskOperations!.begin(token); await operation.close()
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})

it('rejects a managed self mutation through a nested different-session queue without poisoning admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-nested-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } }
  const ownership = createOwnership(backend, opts), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations)
  let documents: ReturnType<typeof createDocuments>, parent: Awaited<ReturnType<ReturnType<typeof createManagedDocuments>['open']>>, attempted: Promise<unknown> | undefined
  const managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations, undefined, id => documents.observations.assertOutsideOwnedOperations([id]))
  documents = createDocuments(backend, ownership, () => {}, undefined, { captureParent: document => managed.captureParent(document), validator: { validate(value) { taskDocumentStorageContract.validate(value); attempted = ownership.withSessionOperation('other', () => parent.metadata.admit({ type: 'plan/mode', mode: 'on' })); void attempted.catch(() => {}) } }, open: scope => createTaskDocumentObservation(root, join(root, `${scope.key}.doc.jsonl`), scope) })
  try {
    await mutations.create({ sessionId: 'parent' }); parent = await managed.open('parent')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operation = await documents.taskOperations!.begin(documents.taskOperations!.parent(parent)), result = await operation.observe()
    await expect(attempted).rejects.toThrow(); if (result.kind !== 'present') throw new Error('missing')
    expect((await operation.confirm(result.witness)).kind).toBe('confirmed'); await operation.close()
    expect((await parent.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})

it('rejects an escaped validator continuation after the original operation closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-escape-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } }
  const ownership = createOwnership(backend, opts), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations), gate = Promise.withResolvers<void>()
  const managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations)
  let escaped: Promise<void> | undefined
  const documents = createDocuments(backend, ownership, () => {}, undefined, { captureParent: document => managed.captureParent(document), validator: { validate(value) { taskDocumentStorageContract.validate(value); escaped = gate.promise.then(() => documents.putDocumentStrict('task-parent', value)); void escaped.catch(() => {}) } }, open: scope => createTaskDocumentObservation(root, join(root, `${scope.key}.doc.jsonl`), scope) })
  try {
    await mutations.create({ sessionId: 'parent' }); const parent = await managed.open('parent')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operation = await documents.taskOperations!.begin(documents.taskOperations!.parent(parent)); await operation.observe(); await operation.close()
    gate.resolve(); await expect(escaped).rejects.toThrow()
  } finally { gate.resolve(); await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})

it('retains the original failed-begin pin cleanup with falsey acquisition and cleanup causes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-begin-debt-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } }
  const ownership = createOwnership(backend, opts), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations)
  const managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations)
  const documents = createDocuments(backend, ownership, () => {}, undefined, { captureParent: document => managed.captureParent(document), validator: taskDocumentStorageContract, open: scope => createTaskDocumentObservation(root, join(root, `${scope.key}.doc.jsonl`), scope) })
  try {
    await mutations.create({ sessionId: 'parent' }); const parent = await managed.open('parent'), token = documents.taskOperations!.parent(parent)
    const pin = ownership.pinOwnership, lease = ownership.acquireDocumentLease; let releaseFails = true
    ownership.pinOwnership = async id => { const claim = await pin(id), release = claim.release; claim.release = async () => { if (releaseFails) throw false; await release() }; return claim }
    ownership.acquireDocumentLease = async id => { if (id === 'task-parent') throw null; return lease(id) }
    let error: unknown; try { await documents.taskOperations!.begin(token) } catch (caught) { error = caught }
    expect((error as Error).cause).toBeNull(); expect((error as Error & { cleanupCause: unknown }).cleanupCause).toBe(false)
    const cleanup = documents.taskOperations!.cleanupFor(error)!; await expect(cleanup.retry()).rejects.toBe(false)
    releaseFails = false; await cleanup.retry(); ownership.pinOwnership = pin; ownership.acquireDocumentLease = lease
    const operation = await documents.taskOperations!.begin(token); await operation.close()
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})

it('rejects a replaced backend write method before invoking either body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-write-method-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } }
  const ownership = createOwnership(backend, opts), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations), managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations)
  let mutable: { issue(): Promise<import('../src/coordinator/task-document-types.ts').TaskWriteOutcome>; reconcile(): Promise<import('../src/coordinator/task-document-types.ts').TaskWriteOutcome>; retry(): Promise<import('../src/coordinator/task-document-types.ts').TaskWriteOutcome>; outcome(): import('../src/coordinator/task-document-types.ts').TaskWriteOutcome | undefined }, replacementCalls = 0
  const documents = createDocuments(backend, ownership, () => {}, undefined, { captureParent: document => managed.captureParent(document), validator: taskDocumentStorageContract, open(scope) {
    const raw = createTaskDocumentObservation(root, join(root, `${scope.key}.doc.jsonl`), scope)
    return { observe: () => raw.observe(), confirm: witness => raw.confirm(witness), settleResources: () => raw.settleResources(), stageWrite(witness, bytes) { const original = raw.stageWrite(witness, bytes); mutable = { issue: () => original.issue(), reconcile: () => original.reconcile(), retry: () => original.retry(), outcome: () => original.outcome() }; return mutable } }
  } })
  try {
    await mutations.create({ sessionId: 'parent' }); const parent = await managed.open('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operation = await documents.taskOperations!.begin(documents.taskOperations!.parent(parent)), observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('missing')
    const write = operation.stageWrite(observed.witness, { formatVersion: 2, tasks: [], notifications: [] })
    mutable!.retry = async () => { replacementCalls++; throw new Error('replacement') }
    await expect(write.issue()).rejects.toThrow('Changed task capability method'); expect(replacementCalls).toBe(0); await operation.close()
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})

it('hands off a confirmed read once after clean close without granting write acknowledgement', async () => {
  const {createProcessReadLatches}=await import('../src/coordinator/process-read-latches.ts')
  const root=await mkdtemp(join(tmpdir(),'ih-read-handoff-')), backend=createJsonlBackend(root), opts={lock:{enabled:true}}, latches=createProcessReadLatches()
  const ownership=createOwnership(backend,opts), mutations=createMutations(backend,ownership,200,()=>{}), loads=createLoads(backend,ownership,mutations), managed=createManagedDocuments(backend,ownership,loads.loadOwned,opts,()=>{},mutations)
  const documents=createDocuments(backend,ownership,()=>{},latches,{captureParent:document=>managed.captureParent(document),validator:taskDocumentStorageContract,open:scope=>createTaskDocumentObservation(root,join(root,`${scope.key}.doc.jsonl`),scope)})
  try {
    await mutations.create({sessionId:'parent'}); const parent=await managed.open('parent'); await writeFile(join(root,'task-parent.doc.jsonl'),'{"formatVersion":2,"tasks":[],"notifications":[]}')
    const op=await documents.taskOperations!.begin(documents.taskOperations!.parent(parent)), observed=await op.observe(); if(observed.kind!=='present') throw Error('missing')
    await op.confirm(observed.witness); const handoff=op.prepareReadHandoff(observed.witness)
    expect(()=>handoff.consume.call({})).toThrow(); await op.close(); expect(()=>op.assertHandoff()).toThrow(); handoff.consume(); expect(()=>handoff.consume()).toThrow(); handoff.abandon()
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root,{recursive:true,force:true}) }
})

it.each(['mutation','early-consume','abort'] as const)('retires armed reads on %s without blocking cleanup', async mode => {
  const {createProcessReadLatches}=await import('../src/coordinator/process-read-latches.ts')
  const root=await mkdtemp(join(tmpdir(),'ih-read-revoke-')), backend=createJsonlBackend(root), opts={lock:{enabled:true}}, latches=createProcessReadLatches(), controller=new AbortController()
  const ownership=createOwnership(backend,opts), mutations=createMutations(backend,ownership,200,()=>{}), loads=createLoads(backend,ownership,mutations), managed=createManagedDocuments(backend,ownership,loads.loadOwned,opts,()=>{},mutations)
  const documents=createDocuments(backend,ownership,()=>{},latches,{captureParent:document=>managed.captureParent(document),validator:taskDocumentStorageContract,open:scope=>createTaskDocumentObservation(root,join(root,`${scope.key}.doc.jsonl`),scope)})
  try {
    await mutations.create({sessionId:'parent'}); const parent=await managed.open('parent'); await writeFile(join(root,'task-parent.doc.jsonl'),'{"formatVersion":1,"tasks":[],"notifications":[]}')
    const op=await documents.taskOperations!.begin(documents.taskOperations!.parent(parent),{signal:controller.signal}), observed=await op.observe(); if(observed.kind!=='present') throw Error('missing')
    await op.confirm(observed.witness); const read=op.prepareReadHandoff(observed.witness)
    expect(()=>op.prepareReadHandoff(observed.witness)).toThrow(); expect(()=>op.stageWrite(observed.witness,{})).toThrow()
    if(mode==='early-consume') expect(()=>read.consume()).toThrow(); else if(mode==='abort') controller.abort()
    await op.close()
    if(mode==='mutation') await documents.putDocumentStrict('task-parent',{formatVersion:2,tasks:[],notifications:[]})
    expect(()=>read.consume()).toThrow(); read.abandon(); read.abandon(); await documents.taskOperations!.joinTaskDocumentIO()
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root,{recursive:true,force:true}) }
})
it('retains failed close debt and permanently abandons its read', async () => {
  const {createProcessReadLatches}=await import('../src/coordinator/process-read-latches.ts')
  const root=await mkdtemp(join(tmpdir(),'ih-read-close-debt-')), backend=createJsonlBackend(root), opts={lock:{enabled:true}}, latches=createProcessReadLatches()
  const ownership=createOwnership(backend,opts), mutations=createMutations(backend,ownership,200,()=>{}), loads=createLoads(backend,ownership,mutations), managed=createManagedDocuments(backend,ownership,loads.loadOwned,opts,()=>{},mutations)
  const documents=createDocuments(backend,ownership,()=>{},latches,{captureParent:document=>managed.captureParent(document),validator:taskDocumentStorageContract,open:scope=>createTaskDocumentObservation(root,join(root,`${scope.key}.doc.jsonl`),scope)})
  try {
    await mutations.create({sessionId:'parent'}); const parent=await managed.open('parent'); await writeFile(join(root,'task-parent.doc.jsonl'),'{"formatVersion":2,"tasks":[],"notifications":[]}')
    const original=ownership.acquireDocumentLease; let fail=true
    ownership.acquireDocumentLease=async key=>{const lease=await original(key); return {get held(){return lease.held}, async release(){if(fail) throw null; await lease.release()}}}
    const op=await documents.taskOperations!.begin(documents.taskOperations!.parent(parent)), observed=await op.observe(); if(observed.kind!=='present') throw Error('missing')
    await op.confirm(observed.witness); const read=op.prepareReadHandoff(observed.witness)
    await expect(op.close()).rejects.toBeNull(); read.abandon(); expect(()=>read.consume()).toThrow(); await expect(documents.taskOperations!.joinTaskDocumentIO()).rejects.toThrow()
    fail=false; await op.retryClose(); await documents.taskOperations!.joinTaskDocumentIO(); expect(()=>read.consume()).toThrow()
  } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root,{recursive:true,force:true}) }
})
