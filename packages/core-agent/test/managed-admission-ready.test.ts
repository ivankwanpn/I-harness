import { expect, it, vi, onTestFinished } from 'vitest';
vi.mock('@i-harness/core-session', async (load) => { const original = await load<typeof import('@i-harness/core-session')>(); return { ...original, createManagedSessionState() { throw Error('Private Agent built a full managed view'); }, projectConversation() { throw Error('Private Agent replayed public conversation'); }, readConversationState() { throw Error('Private Agent replayed public state'); } }; });
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, captureExecutionHookChannel } from '@i-harness/core-plugin';
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin';
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts';
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts';
import { createExecutionGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts';
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts';
import { createLoopbackProvider } from './helpers/provider-loopback.ts';
import { createManagedAgent } from '../src/index.ts';
import { createManagedAgentModelOriginOwner } from '../src/tool-batch/model-origin.ts';

const afterPrepare=vi.hoisted(()=>({armed:false,start:undefined as undefined|(()=>Promise<void>),settled:0}));
vi.mock('../../session-persistence/src/coordinator/ownership.ts',async load=>{const original=await load<typeof import('../../session-persistence/src/coordinator/ownership.ts')>();return {...original,createOwnership(...args:Parameters<typeof original.createOwnership>){const owner=original.createOwnership(...args),operation=owner.withSessionOperation;owner.withSessionOperation=(async (...input:Parameters<typeof operation>)=>{const value=await operation(...input);if(afterPrepare.armed&&value&&typeof value==='object'&&'archive'in value&&'observation'in value&&'settle'in value){afterPrepare.armed=false;await afterPrepare.start?.();const lease=value as {archive:unknown;observation:unknown;assertCurrent():void;settle():Promise<void>};return {...lease,assertCurrent:lease.assertCurrent.bind(lease),async settle(){await lease.settle();afterPrepare.settled++}}}return value}) as typeof operation;return owner}}});
const probe = vi.hoisted(() => ({ hold: undefined as undefined | (() => Promise<void>), failClose: false, unknown: false, nativeReads: 0, resolves: 0, afterUnstartedClose: undefined as undefined | (() => Promise<void>), afterResponseResult: undefined as undefined | (() => void), responseRoot: '', responseLeases: [] as import('../../fs-lock/src/index.ts').SessionLock[] }));
vi.mock('../src/agent/model-step.ts', async (load) => {
    const original = await load<typeof import('../src/agent/model-step.ts')>();
    return { ...original, createModelStep(...args: Parameters<typeof original.createModelStep>) {
            const step = original.createModelStep(...args), result = step.result.bind(step);
            step.result = (...input: Parameters<typeof result>) => {
                const value = result(...input);
                const observed = probe.afterResponseResult;
                probe.afterResponseResult = undefined;
                observed?.();
                return value;
            };
            return step;
        } };
});
vi.mock('../../fs-lock/src/index.ts', async (load) => {
    const original = await load<typeof import('../../fs-lock/src/index.ts')>();
    return { ...original, async acquireSessionLock(...args: Parameters<typeof original.acquireSessionLock>) {
            const lease = await original.acquireSessionLock(...args);
            if (probe.responseRoot && args[0].lockPath.replaceAll('\\', '/').startsWith(probe.responseRoot.replaceAll('\\', '/') + '/'))
                probe.responseLeases.push(lease);
            return lease;
        } };
});
vi.mock('../../session-persistence/src/execution-internal.ts',async load=>{
 const original=await load<typeof import('../../session-persistence/src/execution-internal.ts')>();
 return {...original,openExecutionDependencies(...args:Parameters<typeof original.openExecutionDependencies>){
  const scope=original.openExecutionDependencies(...args),hold=probe.hold;probe.hold=undefined;
  return {assertCurrent:scope.assertCurrent.bind(scope),async readEvent(ordinal:number){const event=await scope.readEvent(ordinal);probe.nativeReads++;return event},async close(){if(hold)await hold();if(hold&&probe.failClose)throw undefined;await scope.close()}}
 }}
});
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{
 const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();
 return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const journal=original.createFactJournalBackend(...args),append=journal.appendOwnedBatch;return {...journal,async appendOwnedBatch(...input:Parameters<typeof append>){const outcome=await append(...input);if(probe.unknown&&Buffer.from(input[3].bytes).toString('utf8').includes('admission-writer'))return {kind:'unknown' as const,key:input[3].key};return outcome}}}}
});
import type {ManagedAction,FactOutcome} from '@i-harness/core-session';
import {deferred} from './helpers/provider-loopback.ts';
const wire=()=> 'data: '+JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})+'\n\ndata: [DONE]\n\n';
for (const mode of ['ready', 'abort', 'falsey-close', 'unknown'] as const)
    it(`joins the original finite operation after the provider response before acceptance ${mode}`, async () => {
        probe.failClose = false;
        probe.unknown = false;
        probe.hold = undefined;
        const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'response-admission-'));
        probe.responseRoot = root;
        probe.responseLeases = [];
        const backend = createJsonlBackend(root);
        const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract);
        let bodyEntered = false, setupServer: Awaited<ReturnType<typeof createLoopbackProvider>> | undefined;
        onTestFinished(async () => {
            if (bodyEntered)
                return;
            probe.failClose = false;
            probe.unknown = false;
            probe.hold = undefined;
            probe.afterResponseResult = undefined;
            const failures: unknown[] = [];
            try {
                await coordinator.close();
            }
            catch (error) {
                failures.push(error);
            }
            try {
                await setupServer?.close();
            }
            catch (error) {
                failures.push(error);
            }
            for (const lease of probe.responseLeases) {
                try {
                    if (lease.held)
                        await lease.release();
                }
                catch (error) {
                    failures.push(error);
                }
            }
            probe.responseRoot = '';
            probe.responseLeases = [];
            if (failures.length)
                throw new AggregateError(failures, 'Original response fixture setup cleanup failed');
        });
        const { id } = await coordinator.create();
        const execution = await acquireManagedExecution(coordinator, id), ctx = createContext();
        const origin = createManagedAgentModelOriginOwner(ctx, execution);
        const pair = createToolRegistryWithModelOrigin(ctx, { executionOwner: { kind: 'managed-execution', domain: origin.domain, context: ctx, sessionId: id } }, origin.verifier);
        const entered = deferred(), release = deferred(), controller = new AbortController();
        const received = execution.owner.registerReceivedInputSource(async () => { });
        expect((await received.captureAdmitted({ type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'original human', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } }).admit()).kind).toBe('committed');
        const writer = execution.owner.beginAction();
        let operation: Promise<unknown> | undefined, completed = false;
        probe.afterResponseResult = () => {
            probe.hold = async () => { entered.resolve(); await release.promise; };
            operation = mode === 'unknown'
                ? writer.captureMetadata!({ type: 'session/title', title: 'admission-writer', source: 'user', messageSeqs: [] }).admit()
                : execution.observe().delivery.ownHuman();
            void operation.catch(() => { });
        };
        const server = await createLoopbackProvider('/v1/chat/completions', [async (response) => { response.end(wire()); }]);
        setupServer = server;
        const agent = createManagedAgent(ctx, { execution, domain: origin.domain, hooks: captureExecutionHookChannel(ctx), modelCallOrigin: origin.bind(pair.registry, pair.driver), tools: pair.registry,
            model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl }), systemPrompt: 'original response', budget: { contextWindow: 4096 }, maxOutputTokens: 128,
            generationFactory: (action, deps) => createExecutionGenerationLifecycle(execution, id, action, undefined, deps) });
        const result = agent.run('one original response', controller.signal).then(value => { completed = true; return { ok: true as const, value }; }, error => { completed = true; return { ok: false as const, error }; });
        let primary: { cause: unknown } | undefined;
        try {
            bodyEntered = true;
            await Promise.race([entered.promise, result.then(value => { if (!value.ok)
                    throw value.error; throw Error('Response operation was not held'); })]);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(completed).toBe(false);
            expect(server.requests).toHaveLength(1);
            expect((await backend.read(id)).events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(0);
            if (mode === 'abort')
                controller.abort();
            if (mode === 'falsey-close')
                probe.failClose = true;
            if (mode === 'unknown')
                probe.unknown = true;
            release.resolve();
            if (mode === 'falsey-close')
                await expect(operation).rejects.toBeUndefined();
            else
                await operation;
            expect((await result).ok).toBe(mode === 'ready');
            expect(server.requests).toHaveLength(1);
            expect((await backend.read(id)).events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(mode === 'ready' ? 1 : 0);
        }
        catch (cause) {
            primary = { cause };
        }
        finally {
            release.resolve();
            probe.failClose = false;
            probe.unknown = false;
            probe.hold = undefined;
            probe.afterResponseResult = undefined;
            await operation?.catch(() => { });
            await result;
            const failures: unknown[] = [];
            for (const close of [() => received.close(), async () => { writer.finish(); }, () => server.close()]) {
                try {
                    await close();
                }
                catch (error) {
                    failures.push(error);
                }
            }
            try {
                if (mode === 'unknown') {
                    await expect(coordinator.close()).rejects.toMatchObject({ message: 'Coordinator cleanup is unresolved' });
                    expect(probe.responseLeases.some(lease => lease.held)).toBe(true);
                }
                else
                    await coordinator.close();
            }
            catch (error) {
                failures.push(error);
            }
            let originalBytes: Buffer | undefined;
            try {
                originalBytes = await readFile(join(root, `${id}.jsonl`));
            }
            catch (error) {
                failures.push(error);
            }
            // Deliberately refused logical cleanup retains its original exclusion.
            // Release only the actual test-owned native handles after every flight has
            // joined; this is OS hygiene and supplies no disposal/acceptance ACK.
            for (const lease of probe.responseLeases) {
                try {
                    if (lease.held)
                        await lease.release();
                }
                catch (error) {
                    failures.push(error);
                }
            }
            if (originalBytes) {
                try {
                    expect(await readFile(join(root, `${id}.jsonl`))).toEqual(originalBytes);
                }
                catch (error) {
                    failures.push(error);
                }
            }
            probe.responseRoot = '';
            probe.responseLeases = [];
            if (primary && !failures.length)
                throw primary.cause;
            if (failures.length)
                throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original response admission cleanup failed', { cause: primary ? primary.cause : failures[0] });
        }
    }, 30000);
for(const mode of ['ready','native-read','abort','Stop','falsey-close','unknown'] as const)it(`actual Agent finite admission native close ${mode}`,async()=>{
 probe.failClose=false;probe.unknown=false;probe.hold=undefined;probe.nativeReads=0;
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'admission-')),backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract),{id}=await c.create(),execution=await acquireManagedExecution(c,id),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:id}},origin.verifier);
 const entered=deferred(),release=deferred(),reconciled=deferred(),sent=deferred(),controller=new AbortController();let action:ManagedAction<FactOutcome>,writing:Promise<unknown>|undefined,reconciles=0;
 const received=execution.owner.registerReceivedInputSource(async()=>{});if(mode==='native-read')expect((await received.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'real-read',text:'native original human',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}).admit()).kind).toBe('committed');
 const unrelated=execution.owner.beginAction(),body=deferred(),producer=unrelated.registerSettlementSource(()=>body.promise);
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{sent.resolve();response.end(wire())}]);
 const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:"original admission",budget:{contextWindow:4096},maxOutputTokens:128,
  generationFactory(original,deps){action=original;return createExecutionGenerationLifecycle(execution,id,original,undefined,deps)},
  requestContext:{async reconcile(){if(++reconciles!==1)return;probe.hold=async()=>{entered.resolve();await release.promise};writing=mode==='native-read'?execution.observe().delivery.ownHuman():action.captureMetadata!({type:'session/title',title:'admission-writer',source:'user',messageSeqs:[]}).admit();await entered.promise;reconciled.resolve()},capture(){return undefined},current(e){return e===undefined},retain(){throw Error('No instructions')},managedSucceeded(){return undefined},promotedHumanRequest(){},async close(){}}
 });
 const result=agent.run('actual finite admission',controller.signal).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
 try{
  await Promise.race([reconciled.promise,result.then(out=>{if(!out.ok)throw out.error;throw Error("early run")})]);await new Promise<void>(r=>setImmediate(r));expect(server.requests).toHaveLength(0);
  if(mode==='abort')controller.abort();if(mode==='Stop')action!.stop();if(mode==='falsey-close')probe.failClose=true;if(mode==='unknown')probe.unknown=true;
  release.resolve();await writing;if(mode==='native-read')expect(probe.nativeReads).toBeGreaterThan(0);
  if((mode==='ready'||mode==='native-read')){await Promise.race([sent.promise,result.then(out=>{if(!out.ok)throw out.error;throw Error("no send")})]);expect(server.requests).toHaveLength(1)}
  body.resolve();const outcome=await result;expect(outcome.ok).toBe((mode==='ready'||mode==='native-read'));expect(server.requests).toHaveLength((mode==='ready'||mode==='native-read')?1:0);expect(reconciles).toBe(1);
 }finally{release.resolve();body.resolve();probe.failClose=false;probe.unknown=false;await result;await received.close();await producer.close();unrelated.finish();await c.close().catch(()=>{});await server.close()}
},30000);

// Delegate real settlement and recovery; these probes control scheduling and
// count the unstarted observation, never substitute its original authority.
vi.mock('../src/agent/unstarted-call-settlement.ts',async load=>{
 const original=await load<typeof import('../src/agent/unstarted-call-settlement.ts')>();
 return {...original,createUnstartedCallSettlement(...args:Parameters<typeof original.createUnstartedCallSettlement>){const owner=original.createUnstartedCallSettlement(...args);return {...owner,async close(){await owner.close();const after=probe.afterUnstartedClose;probe.afterUnstartedClose=undefined;await after?.()}}}}
});
vi.mock('../src/agent/recovery.ts',async load=>{
 const original=await load<typeof import('../src/agent/recovery.ts')>();
 return {...original,createRecovery(...args:Parameters<typeof original.createRecovery>){const owner=original.createRecovery(...args);return {...owner,resolve(...input:Parameters<typeof owner.resolve>){probe.resolves++;return owner.resolve(...input)}}}}
});
for(const mode of ['ready','abort','falsey-close'] as const)it(`actual accepted Agent recovery observation waits for finite original writer ${mode}`,async()=>{
 probe.failClose=false;probe.unknown=false;probe.hold=undefined;probe.afterUnstartedClose=undefined;probe.resolves=0;
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'recovery-admission-')),backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract),{id}=await c.create(),execution=await acquireManagedExecution(c,id),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:id}},origin.verifier);
 const entered=deferred(),release=deferred(),boundary=deferred(),controller=new AbortController(),writer=execution.owner.beginAction();let writing:Promise<unknown>|undefined,completed=false;
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire())}]);
 probe.afterUnstartedClose=async()=>{probe.hold=async()=>{entered.resolve();await release.promise};writing=writer.captureMetadata!({type:'session/title',title:'recovery-finite-writer',source:'user',messageSeqs:[]}).admit();await entered.promise;boundary.resolve()};
 const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'actual accepted response',budget:{contextWindow:4096},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,id,action,undefined,deps)});
 const result=agent.run('one actual response',controller.signal).then(value=>{completed=true;return {ok:true as const,value}},error=>{completed=true;return {ok:false as const,error}});
 try{
  await Promise.race([boundary.promise,result.then(out=>{if(!out.ok)throw out.error;throw Error('Early completion')})]);await new Promise<void>(r=>setImmediate(r));expect(server.requests).toHaveLength(1);expect(probe.resolves).toBe(0);expect(completed).toBe(false);
  if(mode==='abort')controller.abort();if(mode==='falsey-close')probe.failClose=true;release.resolve();await writing;const outcome=await result;expect(outcome.ok).toBe(mode==='ready');expect(probe.resolves).toBe(mode==='ready'?1:0);expect(server.requests).toHaveLength(1);
  const events=(await backend.read(id)).events;expect(events.filter(e=>e.type==='model/exchange-accepted')).toHaveLength(1);expect(events.filter(e=>e.type==='assistant/message')).toHaveLength(1);
 }finally{release.resolve();probe.failClose=false;probe.afterUnstartedClose=undefined;await writing;await result;writer.finish();await c.close().catch(()=>{});await server.close()}
},30000);


it('settles a prepared request before waiting for a real reader started at the return boundary',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'after-prepare-')),backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract),{id}=await c.create(),execution=await acquireManagedExecution(c,id),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:id}},origin.verifier)
 const received=execution.owner.registerReceivedInputSource(async()=>{});expect((await received.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'human',text:'reader',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}).admit()).kind).toBe('committed')
 const entered=deferred(),release=deferred(),sent=deferred();let reading:Promise<unknown>|undefined
 afterPrepare.settled=0;afterPrepare.armed=true;afterPrepare.start=async()=>{probe.hold=async()=>{entered.resolve();await release.promise};reading=execution.observe().delivery.ownHuman();await entered.promise}
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{sent.resolve();response.end(wire())}]);const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'original',budget:{contextWindow:4096},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,id,action,undefined,deps)})
 const result=agent.run('one request').then(value=>({ok:true as const,value}),error=>({ok:false as const,error}))
 try{await Promise.race([entered.promise,result.then(value=>{if(!value.ok)throw value.error;throw Error('request escaped held original reader')})]);await vi.waitFor(()=>expect(afterPrepare.settled).toBe(1));expect(server.requests).toHaveLength(0);release.resolve();await reading;await sent.promise;expect((await result).ok).toBe(true);expect(server.requests).toHaveLength(1)}finally{afterPrepare.armed=false;afterPrepare.start=undefined;release.resolve();await reading;await result;await received.close();await c.close();await server.close()}
},60000)
