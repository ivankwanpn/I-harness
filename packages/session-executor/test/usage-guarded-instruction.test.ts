import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createWaitingGuard,prepareModelRequest} from '@i-harness/llm-seam'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createProjectInstructionEnvironment} from '../src/context/instructions/host.ts'
import {createIsolatedInstructionHost} from '../src/context/instructions/isolated.ts'
afterEach(()=>vi.unstubAllGlobals())
it.each(['clean','stopped','stale'] as const)('original guarded instruction lease preserves real issue progression under %s',async mode=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'guarded-instruction-'));await writeFile(join(root,'AGENTS.md'),'ORIGINAL_GUARDED_RULE')
 const environment=createProjectInstructionEnvironment(),controller=new AbortController();let available=true,fetches=0
 const host=createIsolatedInstructionHost({cwd:root,environment,authority:()=>({kind:'unbound',revision:'original',workspaceRoot:root}),available:()=>true})
 const lease=await host.create({signal:controller.signal,lifetime:{available:()=>available}})
 vi.stubGlobal('fetch',async()=>{fetches++;return new Response('data: {"choices":[{"delta":{"content":"controlled"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 try{
  const client=createWaitingGuard(createOpenAICompatibleClient({apiKey:'fixture',model:'reviewer',baseUrl:'http://127.0.0.1:1'}),{firstResponseMs:1000,progressMs:1000})
  const prepared=await prepareModelRequest(client,{systemPrompt:lease.text,messages:[],tools:[]}),attempt=lease.bind(prepared)
  if(mode==='stopped')controller.abort(Error('Original Stop'))
  if(mode==='stale')available=false
  if(mode==='clean'){const invocation=attempt.open({signal:controller.signal});for await(const _ of invocation.stream){}await invocation.drain();expect(()=>attempt.complete()).not.toThrow();expect(fetches).toBe(1);lease.finish('completed')}
  else{expect(()=>attempt.open({signal:controller.signal})).toThrow();expect(fetches).toBe(0)}
 }finally{await lease.close();await host.close();await environment.close()}
})
