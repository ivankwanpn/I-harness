import {expect,it,vi} from 'vitest'
const observed=vi.hoisted(()=>({service:undefined as import('@i-harness/session-executor').SessionService|undefined,assemblies:0}))
vi.mock('@i-harness/session-executor',async load=>{const actual=await load<typeof import('@i-harness/session-executor')>();return {...actual,createSessionService(...args:Parameters<typeof actual.createSessionService>){const service=actual.createSessionService(...args),original=service.assemblyFor;service.assemblyFor=function(...input){observed.assemblies++;return Reflect.apply(original,service,input)};observed.service=service;return service}}})
import {createServer} from 'node:http'
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {encodeFrame,isRpcSuccess,makeRequest,type RpcMessage} from '@i-harness/sdk'
import {createDesktopHost} from '../src/host.ts'
import {createHostFixtureModel} from './host-fixture-model.ts'
import {originalManagedExecutionFor} from '../../session-executor/src/host-managed-execution.ts'

it('selects the original configured Desktop runtime and joins its owner',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'actual-owned-host-')),workspace=join(root,'workspace');await mkdir(workspace)
 const settingsPath=join(root,'settings.json'),credentialsPath=join(root,'credentials.json'),frames:RpcMessage[]=[],requests:any[]=[]
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));requests.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"owned response"}}]}\n\ndata: [DONE]\n\n')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 await writeFile(settingsPath,JSON.stringify({sandboxMode:'read-only',codeMode:{mode:'off'},llm:{providers:{fixture:{protocol:'openai-completions',baseURL:`${origin}/v1`,apiKeyEnv:'IH_TEST_FIXTURE_KEY',models:[{id:'fixture',contextWindow:32000}]}},defaultModel:{provider:'fixture',model:'fixture'}}}))
 await writeFile(credentialsPath,JSON.stringify({refs:{IH_TEST_FIXTURE_KEY:'fixture'}}))
 let host:Awaited<ReturnType<typeof createDesktopHost>>|undefined,number=0
 const call=async(method:string,params:Record<string,unknown>={})=>{const id=++number;await host!.handleLine(encodeFrame(makeRequest(id,method,params)));const reply=frames.find(frame=>'id'in frame&&frame.id===id);if(!isRpcSuccess(reply))throw Error(JSON.stringify(reply));return reply.result}
 observed.assemblies=0;observed.service=undefined
 try{host=await createDesktopHost({workspace,sessionDir:join(root,'sessions'),settingsPath,credentialsPath,buildProviderClient:createHostFixtureModel(origin),onWrite:frame=>frames.push(frame)});await call('initialize');const {sessionId}=await call('session/create') as {sessionId:string};await call('session/prompt',{sessionId,prompt:'hello original host'});const execution=originalManagedExecutionFor(observed.service!,sessionId);expect(execution).toBeDefined();expect(Object.hasOwn(execution!.owner,'view')).toBe(false);expect(observed.assemblies).toBe(0);const main=requests.find(request=>Array.isArray(request.tools));expect(main).toBeDefined();const names=main.tools.map((tool:any)=>tool.function.name);expect(names).toContain('spawn_agent');expect(names).toContain('schedule_create');expect(names).toContain('shell');const records=(await readFile(join(root,'sessions',`${sessionId}.jsonl`),'utf8')).trim().split('\n').flatMap(line=>JSON.parse(line).events??[]);expect(records.some((event:any)=>event.type==='assistant/message'&&event.text==='owned response')).toBe(true);expect(records.some((event:any)=>event.type==='session/title'&&event.title==='owned response')).toBe(true);await host.close();host=undefined;expect(()=>execution!.observe()).toThrow()}finally{await host?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
},60000)
