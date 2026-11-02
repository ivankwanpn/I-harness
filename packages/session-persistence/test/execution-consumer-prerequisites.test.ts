import {afterEach,expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({unknown:false,appends:0,views:0,captures:0,intakes:[] as {pending():readonly {inputId:string}[]}[],readGate:undefined as undefined|{entered():void;wait:Promise<void>}}))
vi.mock('../../session-persistence-jsonl/src/backend/archive-reader.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/archive-reader.ts')>();return {...original,async readSessionArchive(...args:Parameters<typeof original.readSessionArchive>){const result=await original.readSessionArchive(...args),gate=probe.readGate;if(gate&&args[4]){probe.readGate=undefined;gate.entered();await gate.wait}return result}}})
vi.mock('../../core-session/src/managed/intake-index.ts',async load=>{const original=await load<typeof import('../../core-session/src/managed/intake-index.ts')>();return {...original,createManagedIntakeIndex(){const index=original.createManagedIntakeIndex();probe.intakes.push(index);return index}}})
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(){probe.views++;throw Error('Consumer prerequisite constructed a full managed view')}}})
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const journal=original.createFactJournalBackend(...args);return {...journal,async appendOwnedBatch(...args:Parameters<typeof journal.appendOwnedBatch>){probe.appends++;const outcome=await journal.appendOwnedBatch(...args);return probe.unknown&&outcome.kind==='committed'?{kind:'unknown' as const,key:args[3].key}:outcome}}}}})
vi.mock('../src/coordinator/action-captures.ts',async load=>{const original=await load<typeof import('../src/coordinator/action-captures.ts')>();return {...original,createActionCaptures(...args:Parameters<typeof original.createActionCaptures>){const ports=original.createActionCaptures(...args);if(ports.captureToolCall){const capture=ports.captureToolCall;ports.captureToolCall=(...args:Parameters<typeof capture>)=>{probe.captures++;return capture(...args)}}return ports}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'
import {readAcknowledgedExecutionMembers} from '@i-harness/core-session/internal/execution'
import {derivePlanMode,deriveProjectionRewrite} from '@i-harness/core-session'
import {effectiveSandboxMode} from '../../sandbox-policy/src/session-mode.ts'
import {readRestoredBudget,readRestoredRecovery} from '@i-harness/core-session/internal/restoration'
import {readRestoredConversation} from '@i-harness/core-session/internal/restoration'
const coordinators:ReturnType<typeof composeJsonlTaskTransitionCoordinator>[]=[]
afterEach(async()=>{probe.unknown=false;probe.readGate=undefined;for(const coordinator of coordinators.splice(0))await coordinator.close();probe.appends=0;probe.views=0;probe.captures=0;probe.intakes=[]})
async function fixture(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'consumer-prerequisites-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);coordinators.push(coordinator);await coordinator.create({sessionId:'owner'});const execution=await acquireManagedExecution(coordinator,'owner');probe.appends=0;return {root,backend,coordinator,execution}}
it('observes original inbox and policy without a full view and keeps all-history admission identity after cancellation',async()=>{
 const {execution,coordinator}=await fixture();expect(execution.observe).toBeTypeOf('function')
 const before=execution.observe(),floor=before.eventCount,input=execution.owner.registerReceivedInputSource(async()=>{})
 await input.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'one',text:'pending original input',delivery:'queue',intent:'user'}).admit()
 const action=execution.owner.beginAction();await action.facts.metadata.admit({type:'plan/mode',mode:'on',proposal:'original proposal'});await action.facts.metadata.admit({type:'sandbox/mode',mode:'workspace-write'})
 const current=execution.observe();expect(()=>before.assertCurrent()).toThrow();expect(current.inbox.pending()).toEqual([expect.objectContaining({inputId:'one',text:'pending original input'})]);expect(current.inbox.everAdmitted('one')).toBe(true);expect(current.inbox.isPending('one')).toBe(true)
 expect(()=>current.assertCurrent.call({...current})).toThrow();expect(Object.isFrozen(current.inbox.pending()[0])).toBe(true);expect(current.schedules).toMatchObject({kind:'unavailable',reason:'original-schedule-adapter-not-connected'})
 expect(current.sandboxMode(floor)).toBe('workspace-write');expect(probe.views).toBe(0)
 const document=await coordinator.openManagedDocument!('owner');expect(current.plan()).toEqual(derivePlanMode(document.view));expect(current.sandboxMode(floor)).toBe(effectiveSandboxMode(document.view.events.slice(floor)));expect(current.rewrite()).toEqual(deriveProjectionRewrite(document.view))
 await input.captureCancellation({type:'agent/input/cancelled',version:1,inputId:'one'}).admit();const canceled=execution.observe();expect(canceled.inbox.pending()).toEqual([]);expect(canceled.inbox.everAdmitted('one')).toBe(true);expect(canceled.inbox.isPending('one')).toBe(false)
 await input.close();action.finish()
},20000)
it('original captured tool-call and legacy call use one capture/admission path and never duplicate its fact',async()=>{
 const {execution,backend}=await fixture(),action=execution.owner.beginAction();expect(action.captureToolCall).toBeTypeOf('function');if(!action.captureToolCall)throw Error('Original call capture missing')
 const draft={type:'tool/call' as const,callId:'captured',name:'read',args:{path:'original'}},capture=action.captureToolCall(draft);draft.args.path='changed'
 const outcome=await capture.admit();expect(outcome.kind).toBe('committed');if(outcome.kind!=='committed')throw Error('Original call not committed');expect(await capture.admit()).toBe(outcome)
 expect(readAcknowledgedExecutionMembers(capture,outcome)).toEqual([expect.objectContaining({type:'tool/call',callId:'captured',args:{path:'original'}})]);expect(()=>readAcknowledgedExecutionMembers({...capture},outcome)).toThrow();expect(()=>readAcknowledgedExecutionMembers(capture,{...outcome})).toThrow()
 const legacy=await action.facts.tools.call({type:'tool/call',callId:'legacy',name:'read',args:{}});expect(legacy.kind).toBe('committed');expect(probe.captures).toBe(2);expect(probe.appends).toBe(2);expect((await backend.read('owner')).events.filter(event=>event.type==='tool/call')).toHaveLength(2);action.finish()
},20000)
it('original capture delegate cannot be replaced',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction();expect(()=>Object.defineProperty(action,'captureToolCall',{value:()=>({admit:async()=>({kind:'committed'})})})).toThrow();action.finish()
},20000)
it('observation bindings never invoke hostile accessors',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction()
 await action.facts.metadata.admit({type:'context/recovery',version:1,ownerSessionId:'owner',recoveryId:'original',logicalStepSeq:0,bindingFingerprint:'a'.repeat(64),rejectedInputFingerprint:'b'.repeat(64),state:'required',modelId:'actual',protocol:'openai-compatible'})
 const observation=execution.observe();let reads=0;const hostile=Object.defineProperty({protocol:'openai-compatible'},'modelId',{get(){reads++;throw Error('Hostile binding callback')}})
 expect(()=>observation.recovery(hostile as never)).toThrow();expect(reads).toBe(0);expect(observation.recovery({modelId:'actual',protocol:'openai-compatible'})).toMatchObject({state:'required'});action.finish()
},20000)
it('request preparation requires the original action and its lease refuses revision and Stop with no view fallback',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction();expect(execution.prepareRequest).toBeTypeOf('function')
 await expect(execution.prepareRequest({...action})).rejects.toThrow();const request=await execution.prepareRequest(action);request.assertCurrent();expect(request.observation.identity).toBe(execution.identity)
 await action.facts.metadata.admit({type:'plan/mode',mode:'on'});expect(()=>request.assertCurrent()).toThrow();await request.settle();expect(()=>request.assertCurrent()).toThrow()
 const next=await execution.prepareRequest(action);action.stop();expect(()=>next.assertCurrent()).toThrow();await next.settle();expect(probe.views).toBe(0);action.finish()
},20000)
it('unknown original call cannot supply members or a request until the same capture reconciles',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction();expect(action.captureToolCall).toBeTypeOf('function');if(!action.captureToolCall)throw Error('Original call capture missing')
 const capture=action.captureToolCall({type:'tool/call',callId:'unknown',name:'read',args:{}});probe.unknown=true;const uncertain=await capture.admit();expect(uncertain.kind).toBe('unknown');expect(()=>readAcknowledgedExecutionMembers(capture,uncertain)).toThrow();await expect(execution.prepareRequest(action)).rejects.toThrow()
 probe.unknown=false;const outcome=await capture.reconcile();expect(outcome.kind).toBe('committed');expect(readAcknowledgedExecutionMembers(capture,outcome)).toHaveLength(1);expect(probe.appends).toBe(1);const request=await execution.prepareRequest(action);await request.settle();action.finish()
},20000)
it('request observations expose the actual original budget and recovery folds',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction(),digest='a'.repeat(64)
 const snapshot={version:1 as const,ownerSessionId:'owner',modelId:'actual',protocol:'openai-compatible',bindingFingerprint:digest,bindingRevision:0,projectionRevision:0,neutralFingerprint:digest,identityCoverage:'partial' as const,estimatedInputTokens:10,admissionInputTokens:10,estimateSource:'projected-heuristic' as const,coverage:'complete' as const,confidence:'estimated' as const,roleTokens:{user:10,assistant:0,tool:0},systemTokens:0,schemaTokens:0,reasoningTokens:0,outputReserve:10,capSupport:'unknown' as const,safetyMargin:0,admission:'fit' as const,recoveryRequired:false,fullByProvider:false}
 expect((await action.facts.metadata.admit({type:'context/budget',version:1,snapshot})).kind).toBe('committed')
 expect((await action.facts.metadata.admit({type:'context/recovery',version:1,ownerSessionId:'owner',recoveryId:'original',logicalStepSeq:0,bindingFingerprint:digest,rejectedInputFingerprint:digest,state:'required',modelId:'actual',protocol:'openai-compatible'})).kind).toBe('committed')
 const request=await execution.prepareRequest(action);expect(request.observation.budget()).toEqual(readRestoredBudget(request.archive,'owner'));expect(request.observation.recovery()).toEqual(readRestoredRecovery(request.archive,'owner'));expect(request.observation.contextRevision).toBe(1)
 await request.settle();expect(()=>readRestoredBudget(request.archive,'owner')).toThrow();action.finish()
},20000)
it('an original delivery fence expires request currency before its close fact is admitted',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction(),input=execution.owner.registerReceivedInputSource(async()=>{})
 const admitted=await input.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'human',text:'work',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}}).admit();if(admitted.kind!=='committed')throw Error('Original input absent')
 expect((await input.captureDeliveryOpen({type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:'owner',generationId:'g',originInputSeq:admitted.seqs[0]!},()=>true).admit()).kind).toBe('committed')
 const request=await execution.prepareRequest(action),before=request.observation.eventCount,close=input.captureDeliveryClose({type:'agent/delivery-generation',version:1,op:'close',recipientSessionId:'owner',fenceId:'original-fence',reason:'user-stop'})
 expect(execution.observe().eventCount).toBe(before);expect(()=>request.assertCurrent()).toThrow();expect((await close.admit()).kind).toBe('committed');await request.settle();await input.close();action.finish()
},20000)
it('releases retired original pending payloads only after its original source close acknowledges',async()=>{
 const {execution}=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),input=execution.owner.registerReceivedInputSource(async()=>{entered.resolve();await release.promise})
 await input.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'retained-body',text:'retained original body',delivery:'queue',intent:'user'}).admit()
 const original=probe.intakes.find(index=>index.pending().some(input=>input.inputId==='retained-body'))!;expect(original).toBeDefined()
 const closing=execution.close();await entered.promise;expect(original.pending()).toHaveLength(1);release.resolve();await closing;expect(original.pending()).toHaveLength(0)
},20000)
it('prepares real original request text and refuses publication when Stop wins during its actual descriptor read',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction()
 expect((await action.facts.inputs.start(undefined,{type:'user/message',text:'actual original request text'})).kind).toBe('committed')
 const first=await execution.prepareRequest(action);expect(JSON.stringify(readRestoredConversation(first.archive,{ownerSessionId:'owner'}))).toContain('actual original request text');await first.settle()
 await action.facts.metadata.admit({type:'plan/mode',mode:'on'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();probe.readGate={entered:entered.resolve,wait:release.promise};const preparing=execution.prepareRequest(action);void preparing.catch(()=>{})
 try{await Promise.race([entered.promise,preparing.then(()=>{throw Error('Original request did not enter its descriptor read')})]);action.stop();release.resolve();await expect(preparing).rejects.toMatchObject({code:'FACT_CANCELLED'})}
 finally{release.resolve();action.finish()}
 expect(probe.views).toBe(0)
},20000)
it('legacy call preserves the original closed-document not-issued result without a fresh capture',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction();await execution.close();const before=probe.captures
 expect(await action.facts.tools.call({type:'tool/call',callId:'closed',name:'read',args:{}})).toMatchObject({kind:'not-issued',code:'FACT_CLOSED'});expect(probe.captures).toBe(before);expect(probe.appends).toBe(0);action.finish()
},20000)
