import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { deriveMessages, fromJSONL } from '@i-harness/core-session'
import { createSessionService } from '@i-harness/session-executor'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createSdkServer } from '../src/server.ts'
import { decodeFrame, encodeFrame, isRpcSuccess, makeRequest, type HistoryRange } from '../src/protocol.ts'
import { restorePromotedHistoryImages } from '../src/index.ts'

it('projects the same prepared image and failed tool from live and restarted public history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-history-image-'))
  const photo = {mediaType:'image/png', dataBase64:'QUJD', name:'visible.png'}
  let sends = 0
  const model = controlledModel(async function* () {
    if (++sends === 1) yield {type:'tool_call',call:{id:'tool-1',name:'fixture_failure',args:{}}}
    else yield {type:'text/chunk',text:'Handled the tool error.'}
    yield {type:'end'}
  })
  function open() {
    const backend = createJsonlBackend(root)
    const coordinator = composeJsonlTaskTransitionCoordinator(backend, {lock:{enabled:true}}, taskDocumentStorageContract)
    const service = createSessionService({workspace:root,coordinator,model,contextWindow:16000,maxOutputTokens:128,managedRuntime:{
      systemPrompt:'Test', prepareInput:async text => text + ' prepared', tools:[{
        name:'fixture_failure',description:'Controlled failure',inputSchema:{type:'object'},isReadOnly:true,async execute(){throw Error('fixture failure')}
      }],
    }})
    const server = createSdkServer(service,{coordinator})
    let id = 0
    async function rpc<T>(method:string, params: object = {}): Promise<T> {
      const reply = decodeFrame((await server.handleLine(encodeFrame(makeRequest(++id,method,params))))!)
      if (!isRpcSuccess(reply)) throw Error('Unexpected SDK response for '+method+': '+JSON.stringify(reply))
      return reply.result as T
    }
    return {coordinator,rpc,async close(){await server.close();await service.close();await coordinator.close()}}
  }
  let runtime = open()
  try {
    await runtime.rpc('initialize')
    await runtime.coordinator.create({sessionId:'main'})
    await runtime.rpc('session/prompt',{sessionId:'main',prompt:'Inspect the image',images:[photo]})
    const page = () => runtime.rpc<HistoryRange>('session/history',{sessionId:'main',afterSeq:0,limit:1000,includeTurns:true})
    const live = await page()
    const source = fromJSONL(await readFile(join(root,'main.jsonl'),'utf8'))
    expect(source.events).toContainEqual(expect.objectContaining({type:'agent/input/preparation',op:'promoted'}))
    const projected = deriveMessages(source)
    expect(projected).toContainEqual(expect.objectContaining({role:'tool', isError:true}))
    const check = (history:HistoryRange) => {
      const admission = history.events.find(event => event.type === 'agent/input/admitted')
      const promoted = history.events.find(event => event.type === 'user/message' && event.imageInputId)
      expect(admission).not.toHaveProperty('images')
      expect(promoted).toMatchObject({images:[photo]})
      expect(deriveMessages({...source,events:restorePromotedHistoryImages(history.events)})).toEqual(projected)
      return promoted!.seq!
    }
    const seq = check(live)
    await runtime.close()
    runtime = open()
    await runtime.rpc('initialize')
    const cold = await page()
    expect(cold).toEqual(live)
    check(cold)
    const partial = await runtime.rpc<HistoryRange>('session/history',{sessionId:'main',afterSeq:seq,limit:1})
    expect(partial.events).toMatchObject([{type:'user/message',images:[photo]}])
    expect(() => restorePromotedHistoryImages(partial.events)).toThrow(/earlier admission/)
    expect(sends).toBe(2)
  } finally { await runtime.close(); await rm(root,{recursive:true,force:true}) }
}, 60000)
