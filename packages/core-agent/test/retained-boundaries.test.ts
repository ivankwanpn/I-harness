import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createAgent } from '../src/index.ts'
import { createMockClient } from '@i-harness/llm-mock'
import { observeModelClient } from '@i-harness/llm-seam'
import { localTestGeneration } from './fixtures/generation.ts'

it.each(['truncated','refused','empty'] as const)('retains the original %s step closure and its remaining turn closure exactly once after unknown',async kind=>{
  const root=await mkdtemp(join(tmpdir(),'ih-f1-closure-')),backend=createJsonlBackend(root),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}})
  const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),ctx=createContext(),tools=createToolRegistry(ctx)
  let key:BatchKey|undefined,sends=0,hooks=0,blocked=true
  ctx.on('agent/stop',()=>{hooks++})
  const actual=backend.appendOwnedBatch!,reconcile=backend.reconcileOwnedBatch!
  backend.appendOwnedBatch=async(...args)=>{const out=await actual(...args);if(decodeFactBatch(args[3].bytes).events.some(event=>event.type==='step/end')){key=args[3].key;return{kind:'unknown',key}}return out}
  backend.reconcileOwnedBatch=async(...args)=>blocked?{kind:'unknown',key:args[3].key}:reconcile(...args)
  const model = observeModelClient(createMockClient([{ role: 'assistant', ...(kind === 'empty' ? {} : { [kind]: true }) }]), { start() { sends++ }, finish() {} })
  const agent=createAgent(ctx,{session:document.view,factOwner:document,generationFactory:localTestGeneration(document,id,model),sessionId:id,tools,systemPrompt:'',model})
  try{
    await expect(agent.run('finish this boundary')).rejects.toThrow()
    expect(key).toBeDefined();expect(sends).toBe(1);expect(hooks).toBe(0)
    await expect(document.close()).rejects.toThrow()
    blocked=false;await document.reconcile(key!)
    await document.close()
    const events=(await backend.read(id)).events
    expect(events.filter(event=>event.type==='step/end')).toEqual([expect.objectContaining({type:'step/end',[kind]:true})])
    expect(events.filter(event=>event.type==='turn/end')).toHaveLength(1)
    expect(events.map(event=>event.seq)).toEqual(events.map((_,index)=>index))
    expect([sends,hooks]).toEqual([1,0])
  }finally{await coordinator.close().catch(()=>{})}
})
