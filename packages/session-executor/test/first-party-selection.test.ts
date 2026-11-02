import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService,type SessionServiceOptions} from '../src/service.ts'
import {enrollFirstPartySelection,type FirstPartySelection} from '../src/first-party-selection.ts'
const enroll=(options:SessionServiceOptions,owner:Omit<FirstPartySelection,'options'>)=>enrollFirstPartySelection(Object.freeze({options,...owner}))
import {createDurableSessionLoader} from '../src/durable-session.ts'
import {controlledModel} from './controlled-model.ts'
import {prepareOriginalManagedRuntime,originalManagedRuntimeFor} from '../src/host-managed-execution.ts'

it('prepares a UI mutation only after the paired decision without issuing a model request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-ui-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'managed'});await coordinator.create({sessionId:'complete'})
 let calls=0;const model=controlledModel(async function*(){calls++;yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(id){return {kind:id==='managed'?'managed':'complete',assertCurrent(){}}}})
 const service=createSessionService(options)
 try{expect(originalManagedRuntimeFor(service,'managed')).toBeUndefined();expect(await prepareOriginalManagedRuntime(service,'complete')).toBeUndefined();const runtime=await prepareOriginalManagedRuntime(service,'managed');expect(runtime).toBeDefined();runtime!.assertCurrent();expect(calls).toBe(0);await service.closeSession('managed');expect(()=>runtime!.assertCurrent()).toThrow()}finally{await service.close();await coordinator.close()}
},30000)

it('first-party preflight selects original managed runtime despite complete options, once per session',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-select-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 let preparations=0,published=false;const model=controlledModel(async function*(){yield {type:'end'}})
 const options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(){preparations++;return {kind:'managed',assertCurrent(){}}}})
 const service=createSessionService(options),off=service.onManagedRuntimeLifecycle!(event=>{if(event.kind==='published')published=true})
 try{await service.submit('main','hello',new AbortController().signal);expect(published).toBe(true);expect(preparations).toBe(1)}finally{off();await service.close();await coordinator.close()}
},30000)
it('first-party complete decision preserves the exact Session callback',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-complete-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 let loader=0;const model=controlledModel(async function*(){yield {type:'end'}})
 const options:SessionServiceOptions={workspace:root,coordinator,sessionFor:async()=>{loader++;throw Error('original complete callback')},managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 expect(()=>enroll(options,{async prepare(){return {kind:'complete',assertCurrent(){}}}})).toThrow('Custom Session loader')
 const service=createSessionService(options)
 try{await expect(service.submit('main','hello',new AbortController().signal)).rejects.toThrow('original complete callback');expect(loader).toBe(1)}finally{await service.close();await coordinator.close()}
},30000)

it('shares a held preflight and rejects it after session close before acquisition',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-close-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let preparations=0,published=false
 const model=controlledModel(async function*(){yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(){preparations++;entered.resolve();await release.promise;return {kind:'managed',assertCurrent(){}}}})
 const service=createSessionService(options),off=service.onManagedRuntimeLifecycle!(event=>{if(event.kind==='published')published=true})
 const one=service.managedInputFor!('main'),two=service.managedInputFor!('main');void one.catch(()=>{});void two.catch(()=>{})
 try{await entered.promise;let closed=false;const closing=service.closeSession('main').then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false);release.resolve();await expect(one).rejects.toThrow();await closing;expect(closed).toBe(true);await expect(two).rejects.toThrow();expect(preparations).toBe(1);expect(published).toBe(false)}finally{release.resolve();off();await service.close();await coordinator.close()}
},30000)

it('exposes no model early and follows the exact live binding after idle rebind',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-model-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const first=controlledModel(async function*(){yield {type:'end'}}),second=controlledModel(async function*(){yield {type:'end'}});let binding:(()=>import('../src/managed-assembly.ts').ManagedExecutionModelBinding)|undefined,early=false
 const options:SessionServiceOptions={workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],async mountDefaultSurface(original,live){binding=live.modelBinding;try{live.modelBinding()}catch{early=true}return {systemPrompt:()=> 'system',modelToolSchemas:live.modelToolSchemas,modelOverheadTokens:()=>10,async prepareInput(text){return text},async reconcileAuthority(){original.assertCurrent()}}}},model:first,contextWindow:32000,maxOutputTokens:128}
 const service=createSessionService(options)
 try{await service.submit('main','hello',new AbortController().signal);expect(early).toBe(true);expect(binding!().model).toBe(first);expect(service.rebindModel('main',{model:second,providerId:'p',modelId:'second',label:'second',contextWindow:16000})).toBe(true);expect(binding!().model).toBe(second);expect(binding!().contextWindow).toBe(16000);await service.closeSession('main');expect(()=>binding!()).toThrow()}finally{await service.close();await coordinator.close()}
},30000)

it('refuses new private work when the original preflight becomes stale',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-stale-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 let current=true,calls=0;const model=controlledModel(async function*(){calls++;yield {type:'end'}})
 const options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(){return {kind:'managed',assertCurrent(){if(!current)throw Error('configuration changed')}}}})
 const service=createSessionService(options)
 try{await service.submit('main','hello',new AbortController().signal);current=false;await expect(service.submit('main','again',new AbortController().signal)).rejects.toThrow('configuration changed');expect(calls).toBe(1)}finally{await service.close();await coordinator.close()}
},30000)

it('rejects reentrant preflight without issuing a second selection',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-reentry-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 let calls=0;const model=controlledModel(async function*(){yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128};let service:ReturnType<typeof createSessionService>
 enroll(options,{async prepare(id){calls++;await service.managedInputFor!(id);return {kind:'managed',assertCurrent(){}}}});service=createSessionService(options)
 try{await expect(service.managedInputFor!('main')).rejects.toThrow('cannot reenter');expect(calls).toBe(1)}finally{await service.close();await coordinator.close()}
},30000)
it('rejects replaced decision currentness before further private work',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-mutation-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const model=controlledModel(async function*(){yield {type:'end'}}),decision={kind:'managed' as const,assertCurrent(){}},options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(){return decision}});const service=createSessionService(options)
 try{await service.submit('main','hello',new AbortController().signal);decision.assertCurrent=()=>{};await expect(service.submit('main','again',new AbortController().signal)).rejects.toThrow('decision changed')}finally{await service.close();await coordinator.close()}
},30000)

it('rejects asynchronous currentness rather than treating its promise as authority',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-async-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const model=controlledModel(async function*(){yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(){return {kind:'managed',async assertCurrent(){throw Error('not synchronous')}}}});const service=createSessionService(options)
 try{await expect(service.managedInputFor!('main')).rejects.toThrow('must be synchronous')}finally{await service.close();await coordinator.close()}
},30000)

it('keeps a public Session observer on complete compatibility when added during preflight',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-custom-hook-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let published=false,complete=false
 const model=controlledModel(async function*(){yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(){entered.resolve();await release.promise;return {kind:'managed',assertCurrent(){}}}});const service=createSessionService(options),offLifecycle=service.onManagedRuntimeLifecycle!(event=>{if(event.kind==='published')published=true})
 const submission=service.submit('main','hello',new AbortController().signal);void submission.catch(()=>{})
 try{await entered.promise;const off=service.onAssembly(()=>{complete=true});release.resolve();await submission;expect(complete).toBe(true);expect(published).toBe(false);off()}finally{release.resolve();offLifecycle();await service.close();await coordinator.close()}
},30000)

it('refuses unknown option surfaces rather than ignoring them',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-unsupported-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 const model=controlledModel(async function*(){yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),additionalTools:[],managedRuntime:{systemPrompt:'system',tools:[]},model}
 Object.defineProperty(options,'unknownOption',{value:true,enumerable:true});try{expect(()=>enroll(options,{async prepare(){return {kind:'managed',assertCurrent(){}}}})).toThrow('Unknown first-party service option: unknownOption')}finally{await coordinator.close()}
},30000)

it('rejects mutation of the original managed tool surface before acquisition',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-tools-mutate-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const tools:any[]=[],model=controlledModel(async function*(){yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(){return {kind:'managed',assertCurrent(){}}}});const service=createSessionService(options);tools.push({name:'injected',description:'injected',inputSchema:{type:'object'},async execute(){return 'x'}})
 try{await expect(service.managedInputFor!('main')).rejects.toThrow('managed tools changed')}finally{await service.close();await coordinator.close()}
},30000)

it('retains failed selection release for explicit close retry',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-release-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 let releases=0;const model=controlledModel(async function*(){yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(){return {kind:'managed',assertCurrent(){}}},async release(){if(++releases===1)throw Error('release held')}});const service=createSessionService(options)
 try{await service.submit('main','hello',new AbortController().signal);await expect(service.closeSession('main')).rejects.toThrow('release held');expect(releases).toBe(1);await service.closeSession('main');expect(releases).toBe(2)}finally{await service.close();await coordinator.close()}
},30000)

it('pins false and empty complete configuration on the trusted paired product',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-false-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const extra:any[]=[],model=controlledModel(async function*(){yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),additionalTools:extra,approveAll:false,managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(){return {kind:'managed',assertCurrent(){}}}});const service=createSessionService(options)
 try{extra.push({name:'changed',description:'changed',inputSchema:{type:'object'},async execute(){return 'x'}});await expect(service.managedInputFor!('main')).rejects.toThrow('complete additionalTools changed')}finally{await service.close();await coordinator.close()}
},30000)

it('does not bypass a held first-party decision through the generic managed classifier',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'paired-held-bypass-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let published=false
 const model=controlledModel(async function*(){yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enroll(options,{async prepare(){entered.resolve();await release.promise;return {kind:'managed',assertCurrent(){}}}});const service=createSessionService(options),off=service.onManagedRuntimeLifecycle!(event=>{if(event.kind==='published')published=true})
 const input=service.managedInputFor!('main');void input.catch(()=>{})
 try{await entered.promise;const assembly=await service.assemblyFor('main');expect(assembly.sessionId).toBe('main');release.resolve();expect(await input).toBeUndefined();expect(published).toBe(false)}finally{release.resolve();off();await service.close();await coordinator.close()}
},30000)
