import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {actionMetadataFacts} from '../../session-executor/src/lifecycle/action-facts.ts'
import {committedFactSeqs} from '@i-harness/core-session'
import {createOwnedGatewayPromptParts} from '../src/owned-gateway-prompt-parts.ts'

it('renders current original sandbox, project and shell inputs',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-prompt-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const model=controlledModel(async function*(){yield {type:'end'}});let original:any,parts:ReturnType<typeof createOwnedGatewayPromptParts>|undefined,revoked=false
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],mountRegistry(value){original=value;parts=createOwnedGatewayPromptParts(value,{workspace:root,rewindEnabled:true,mode:()=> 'workspace-write',authority:()=>revoked?{kind:'revoked',revision:'2',reason:'revoked'}:{kind:'bound',revision:'1',primaryRoot:root,roots:[root],references:[]},project:()=>({id:'p',name:'Project',roots:[root],primaryRoot:root}),shell:()=>({id:'shell',label:'Shell',command:'sh',dialect:'posix'})})}},model,contextWindow:4096,maxOutputTokens:128})
 try{await service.submit('main','hello',new AbortController().signal);expect(parts!.policy()).toContain('workspace-write');expect(parts!.project()).toContain('Project');expect(parts!.shell()).toContain('Shell');committedFactSeqs(await actionMetadataFacts(original.execution.owner).admit({type:'sandbox/mode',mode:'read-only'}));expect(parts!.policy()).toContain('read-only');revoked=true;expect(()=>parts!.policy()).toThrow(/revoked/)}finally{await service.close();await coordinator.close()}
},30000)
