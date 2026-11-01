import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { registerCodeMode } from '../../code-mode/src/register.ts'
import { observeOriginalCodeFinalOutputs, type FinalCodeOutputDisposition } from '../../code-mode/src/final-output.ts'
import { createCodeFinalOutputRetention } from '../src/lifecycle/code-final-output-retention.ts'
import { createProcessAwareResultService } from '../src/lifecycle/process-result-service.ts'

it('reads the genuine Code manifest through the original process page and refuses replaced readers or lost current scope',async()=>{
  const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'code-process-')),coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract)
  let available=true,revoke=false
  const sourceFor=async()=>{if(revoke)available=false;return {sourceId:'original-process-source',readonly:true}}
  const bridge=createProcessAwareResultService({root:join(root,'outputs'),workspaceId:'process-code',orderingCoordinators:[coordinator],coordinatorFor:()=>coordinator,sourceFor,genericVisible:async()=>false})
  const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),ctx=createContext(),tools=createToolRegistry(ctx)
  const mount=registerCodeMode(ctx,tools,{session:document.view,sessionId:id,factOwner:document,config:{mode:'mixed'},finalOutput:createCodeFinalOutputRetention({service:bridge.service,sourceFor})})
  let output!: {settle():Promise<FinalCodeOutputDisposition>}
  const off=observeOriginalCodeFinalOutputs(mount,(_id,original)=>{output=original})
  const native=bridge.service.readCodeOutputResult!
  try{
    expect(await tools.get('code_exec')!.execute({code:'audio({type:"audio",mimeType:"audio/wav",data:"YQ=="})',yield_time_ms:60000},{session:document.view,sessionId:id})).toMatchObject({status:'completed'})
    const final=await output.settle();if(final.kind!=='ready')throw new Error('Expected original managed manifest')
    const read=()=>coordinator.withProcessReadObservation!(id,{documentKeys:[]},()=>bridge.withPage(coordinator,id,()=>available,()=>bridge.service.readCodeOutputResult!({sessionId:id},{ref:final.ref})),async value=>value)
    expect(await read()).toMatchObject({items:[{item:{kind:'audio',read:'current-fact-required'}}],eof:true})
    let substituted=0
    bridge.service.readCodeOutputResult=async()=>{substituted++;throw new Error('Substitute must not run')}
    await expect(read()).rejects.toThrow();expect(substituted).toBe(0)
    bridge.service.readCodeOutputResult=native
    revoke=true
    await expect(read()).rejects.toThrow()
  }finally{bridge.service.readCodeOutputResult=native;available=true;revoke=false;off();await mount.dispose();await coordinator.close();await bridge.service.close();bridge.retireBridge()}
},30000)
