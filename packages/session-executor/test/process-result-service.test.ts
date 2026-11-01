import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createProcessAwareResultService, lookupProcessResultService } from '../src/lifecycle/process-result-service.ts'

it('creates its own real result service and preserves generic page scope behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-service-')), coordinator = createSessionCoordinator(createJsonlBackend(root))
  const owner = createProcessAwareResultService({ root, workspaceId: 'w', coordinatorFor: () => coordinator, sourceFor: async () => ({ sourceId: 's', readonly: true }), genericVisible: async () => false })
  try {
    expect(lookupProcessResultService(owner.service)).toBeDefined()
    expect(lookupProcessResultService({ ...owner.service })).toBeUndefined()
    expect(await owner.withPage(coordinator, 's', () => true, async () => 'ok')).toBe('ok')
    owner.retireBridge()
    await expect(owner.withPage(coordinator, 's', () => true, async () => 'bad')).rejects.toThrow()
  } finally { await owner.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
it('forwards the original core metadata acquisition through its process-aware service',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'metadata-bridge-')),coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract),bridge=createProcessAwareResultService({root,workspaceId:'w',coordinatorFor:()=>coordinator,sourceFor:async()=>({sourceId:'s',readonly:true}),genericVisible:async()=>false})
 try{await coordinator.create({sessionId:'source'});const document=await coordinator.openManagedDocument('source'),{createResultObservationScope,legacyObservationFor}=await import('../src/lifecycle/result-observation.ts'),scopes=createResultObservationScope()
 await coordinator.withExistingSessionBindingObservation!({sessionIds:['source']},observation=>scopes.run({sessionId:'source',sessionIds:['source'],observation,document,currentSource(){return {sourceId:'s',readonly:true}},assertHostCurrent(){}},async()=>{const metadata=await bridge.acquireSelectedMetadata(legacyObservationFor(scopes.current('source')!));expect((await metadata.reader.legacy()[Symbol.asyncIterator]().next()).done).toBe(true);await metadata.close()}));bridge.retireBridge();await expect(bridge.acquireSelectedMetadata({} as any)).rejects.toThrow()
 }finally{await bridge.service.close();await coordinator.close()}
})
