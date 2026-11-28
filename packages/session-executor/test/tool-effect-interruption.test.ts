import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Tool } from '@i-harness/core-tools'
import { createSdkServer } from '../../sdk/src/server.ts'
import { deriveMessages } from '@i-harness/core-session'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createSessionService } from '../src/service.ts'
import { controlledModel } from './controlled-model.ts'

it.each(['deadline', 'stop', 'managed-stop'] as const)('preserves the original single dispatched mutation after %s', async mode => {
  const dir = await mkdtemp(join(tmpdir(), 'ih-tool-effect-')), file = join(dir, 'effects.txt')
  const backend = createJsonlBackend(join(dir,'sessions'))
  const coordinator = composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
  await coordinator.create({sessionId:'main'})
  const entered = Promise.withResolvers<void>()
  const tool: Tool = {name:'append_fixture',description:'Append once.',inputSchema:{type:'object'},isReadOnly:false,isConcurrencySafe:true,
    ...(mode === 'deadline' ? {timeoutMs:100} : {}), async execute(_args, exec) {
      await appendFile(file,'effect\n'); entered.resolve()
      const signal = exec.abortSignal!
      if (!signal.aborted) await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
      if (mode !== 'deadline') throw Error('Stopped after appending')
      return {acknowledgedAfterDeadline:true}
    }}
  let sends = 0
  const model = controlledModel(async function*() {
    if (++sends === 1) yield {type:'tool_call',call:{id:'original-effect',name:tool.name,args:{}}}
    else yield {type:'text/chunk',text:'continuing'}
    yield {type:'end'}
  })
  const service = createSessionService({workspace:dir,coordinator,model,
    ...(mode === 'managed-stop' ? {managedRuntime:{tools:[tool],systemPrompt:'test'}} : {
      approvalMode:'full-access' as const,codeMode:{mode:'off' as const},
      retry:{maxRetries:1,initialDelayMs:1,maxDelayMs:1,jitterRatio:0},
    })})
  const server = createSdkServer(service)
  let id = 0
  const rpc = async(method:string,params:unknown={}) => JSON.parse((await server.handleLine(JSON.stringify({jsonrpc:'2.0',id:++id,method,params})))!)
  try {
    if (mode !== 'managed-stop') (await service.assemblyFor('main')).tools.register(tool)
    await rpc('initialize')
    const prompt = rpc('session/prompt',{sessionId:'main',prompt:'Append once.'})
    if (mode !== 'deadline') {
      await Promise.race([entered.promise, prompt.then(frame=>{throw Error('Tool did not start: '+JSON.stringify(frame))})])
      expect((await rpc('session/cancel',{sessionId:'main'})).result.cancelled).toBe(true)
    }
    const response = await prompt
    if (mode === 'deadline') expect(response.result).toMatchObject({ok:true})
    else expect(response.error).toBeDefined()
    await service.closeSession('main')
    const cold = await backend.read('main')
    expect(await readFile(file,'utf8')).toBe('effect\n')
    expect(cold.events.filter(event=>event.type==='tool/dispatch')).toHaveLength(1)
    const results = cold.events.filter(event=>event.type==='tool/result')
    expect(results).toHaveLength(1)
    if (mode === 'managed-stop') expect(results[0]).toMatchObject({callId:'original-effect', isError:true, output:{code:'TOOL_ABORTED_MID_FLIGHT'}})
    else expect(results[0]).toMatchObject({callId:'original-effect',envelope:{execution:{dispatch:'dispatched',outcome:'unknown'}}})
    expect(deriveMessages({formatVersion:cold.version,events:cold.events}).filter(event=>event.role==='tool')).toMatchObject([{toolCallId:'original-effect',isError:true}])
  } finally { await server.close(); await service.close(); await coordinator.close(); await rm(dir,{recursive:true,force:true}) }
},30_000)
