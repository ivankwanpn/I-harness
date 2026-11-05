import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend, createJsonlSessionCoordinator } from '../src/index.ts'
import { composeJsonlTaskDocumentCoordinator, composeJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { createDocuments } from '../../session-persistence/src/coordinator/documents.ts'
import { createProcessReadLatches } from '../../session-persistence/src/coordinator/process-read-latches.ts'
import { createSessionCoordinator } from './helpers/composed.ts'
const options = { lock: { enabled: true }, acquireDeadlineMs: 20, acquireRetryMs: 1 }
async function fixture(absent = false) {
  const base = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'canonical-connected-'))
  const root = absent ? join(base, 'absent') : base, backend = createJsonlBackend(root), owner = createOwnership(backend, options)
  const latches = createProcessReadLatches(owner.exclusionScope), documents = createDocuments(backend, owner, () => {}, latches)
  return { root, backend, owner, latches, documents, async close() { await documents.pendingWrites(); await documents.retryDisposals(); await Promise.all(owner.releaseHeldLocks()) } }
}
it('retains each original normalized parent task artifact and each logical live adoption', async () => {
  const f = await fixture(), writer = createSessionCoordinator(createJsonlBackend(f.root), options)
  try {
    await f.owner.ensureOwnership('parent'); await f.owner.ensureOwnership('parent'); await f.owner.ensureOwnership('x/../parent')
    await expect(writer.putDocumentStrict!('parent', {})).rejects.toThrow()
    await expect(writer.putDocumentStrict!('task-parent', {})).rejects.toThrow()
    await f.owner.releaseOwnershipUnlocked('x/../parent')
    await writer.putDocumentStrict!('parent', {})
    await expect(writer.putDocumentStrict!('task-parent', {})).rejects.toThrow()
    expect(f.owner.hasLiveOwnership('parent')).toBe(true)
    await f.owner.releaseOwnershipUnlocked('parent'); await writer.putDocumentStrict!('task-parent', {})
  } finally { await f.close(); await writer.close() }
})
it('shares actual session .doc and document ownership across coordinators', async () => {
  const f = await fixture(), writer = createSessionCoordinator(createJsonlBackend(f.root), options)
  try { await f.owner.ensureOwnership('name.doc'); await expect(writer.putDocumentStrict!('name', {})).rejects.toThrow(); await f.owner.releaseOwnershipUnlocked('name.doc'); await writer.putDocumentStrict!('name', {}) } finally { await f.close(); await writer.close() }
})
it.each([['parent','task-parent','nested/../task-parent'], ['name.doc','name','nested/../name']])('canonical local mutation revokes owned operations and invalidates read across roles %s', async (id, key, alias) => {
  const f = await fixture()
  try {
    const latch = f.latches.capture({sessionId:id!,documentKeys:[key!],mode:'cold'}); latch.markVerified()
    let revoked = 0, closed = 0
    let registration: ReturnType<typeof f.documents.observations.registerOwnedDocumentOperation>
    registration = f.documents.observations.registerOwnedDocumentOperation(id!, key!, {revoke(){revoked++},async close(){closed++;registration.unregister()},async retryClose(){throw Error('unexpected retry')}})
    await registration.join(); await f.documents.putDocumentStrict(alias!, {ok:true})
    expect(revoked).toBe(1); expect(closed).toBe(1); expect(()=>latch.assertCurrent()).toThrow()
    await f.documents.putDocumentStrict(key!, {ok:false}); expect(()=>latch.assertCurrent()).toThrow(); latch.retire()
  } finally { await f.close() }
})
it('canonical pending and unknown admissions intersect aliases and session/document roles', async () => {
  const f = await fixture()
  try {
    const a = f.documents.observations.beginMutation(['name.doc'], [])
    expect(()=>f.documents.observations.registerOwnedDocumentOperation('other','nested/../name',{revoke(){},async close(){},async retryClose(){}})).toThrow()
    a.finish('unknown')
    const b = f.documents.observations.beginMutation([], ['nested/../task-parent'])
    expect(()=>f.documents.observations.registerOwnedDocumentOperation('parent','task-parent',{revoke(){},async close(){},async retryClose(){}})).toThrow()
    b.finish('settled')
  } finally { await f.close() }
})
it('original root and nested document preparation recaptures before lock and publication', async () => {
  const f = await fixture(true)
  try { await f.documents.putDocumentStrict('nested/key', {ok:true}); expect(await f.backend.getDocument('nested/key')).toEqual({ok:true}); const latch=f.latches.capture({sessionId:'other',documentKeys:['nested/key'],mode:'cold'}); await f.documents.putDocumentStrict('nested/./key',{ok:false}); expect(()=>latch.assertCurrent()).toThrow(); latch.retire() } finally { await f.close() }
})

it.each(['generic','process','task','transition'] as const)('all genuine %s constructors use original document-artifact ownership', async kind => {
  const f = await fixture(), backend = createJsonlBackend(f.root)
  const writer = kind === 'generic' ? createSessionCoordinator(backend, options) : kind === 'process' ? createJsonlSessionCoordinator(f.root, options) : kind === 'task' ? composeJsonlTaskDocumentCoordinator(backend, options, taskDocumentStorageContract) : composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract)
  try { await f.owner.ensureOwnership('parent'); await writer.putDocumentStrict!('unrelated', {ok:true}); await expect(writer.putDocumentStrict!('nested/../task-parent', {})).rejects.toThrow() } finally { await f.close(); await writer.close() }
})
it('custom structural backend copies cannot acquire original task-handoff construction authority', async () => {
  const f = await fixture()
  try { expect(()=>composeJsonlTaskDocumentCoordinator({...f.backend}, options, taskDocumentStorageContract)).toThrow('Original JSONL backend required'); expect(()=>composeJsonlTaskTransitionCoordinator({...f.backend}, options, taskDocumentStorageContract)).toThrow('Original JSONL backend required') } finally { await f.close() }
})
it('canonical document aliases share one temporary lease inside a multi-key operation', async () => {
  const f = await fixture(); let writes=0
  try { await f.documents.withDocumentLeases(['name','nested/../name'],async()=>{writes++}); expect(writes).toBe(1) } finally { await f.close() }
})

it('ready generic writer refuses a nested-directory replacement while original revoked cleanup is joined', async () => {
  const {mkdir,rename,readFile,stat}=await import('node:fs/promises')
  const f=await fixture(), entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>(); let writes=0
  const docs=createDocuments({async putDocument(key,data){writes++;await f.backend.putDocument(key,data)},getDocument:key=>f.backend.getDocument(key)},f.owner,()=>{},f.latches)
  await f.backend.putDocument('nested/key',{original:true})
  const before=await readFile(join(f.root,'nested/key.doc.jsonl'))
  let registration:ReturnType<typeof docs.observations.registerOwnedDocumentOperation>
  registration=docs.observations.registerOwnedDocumentOperation('other','nested/key',{revoke(){},async close(){entered.resolve();await release.promise;registration.unregister()},async retryClose(){throw Error('unexpected retry')}})
  await registration.join()
  const writing=docs.putDocumentStrict('nested/key',{replacement:true}); const outcome=writing.then(()=>({written:true}),cause=>({written:false,cause}))
  try {
    await entered.promise; await rename(join(f.root,'nested'),join(f.root,'original-nested')); await mkdir(join(f.root,'nested')); release.resolve()
    expect((await outcome).written).toBe(false); expect(writes).toBe(0)
    expect(await readFile(join(f.root,'original-nested/key.doc.jsonl'))).toEqual(before)
    await expect(stat(join(f.root,'nested/key.doc.jsonl'))).rejects.toMatchObject({code:'ENOENT'})
  } finally {release.resolve();await outcome;await docs.pendingWrites();await docs.retryDisposals();await f.close()}
})
it('retains the original configured lock directory when its pathname is replaced',async()=>{
 const {mkdir,rename}=await import('node:fs/promises'),f=await fixture()
 const claim=await f.owner.pinOwnership('parent')
 try{await claim.release();await rename(join(f.root,'.i-harness-locks'),join(f.root,'original-locks'));await mkdir(join(f.root,'.i-harness-locks'));expect(()=>claim.assertHeld()).toThrow();await expect(f.owner.pinOwnership('other')).rejects.toThrow()}finally{await claim.release();await f.close()}
})
