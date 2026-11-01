import { afterEach, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => ({ path: '', resident: false, allowPublic: false, views: 0, fullReads: 0, unknown: false, failInstall: false, appends: 0, prefixReads:0, prefixLookups:0, prefixAudit:false, prefixCapture:undefined as undefined|{backend:object;proof:object},prefixAuditResults:[] as unknown[],otherBackend:undefined as object|undefined, sources: [] as unknown[], replyGate: undefined as undefined | {
        entered: (read: unknown) => void;
        wait: Promise<void>;
    }, gate: undefined as undefined | {
        entered: () => void;
        wait: Promise<void>;
    } }));
vi.mock('node:fs/promises', async (load) => {
    const actual = await load<typeof import('node:fs/promises')>();
    return {
        ...actual, async readFile(...args: Parameters<typeof actual.readFile>) {
            if (String(args[0]) === probe.path) {
                probe.fullReads++;
                if (probe.resident)
                    throw Error('hidden complete archive fallback');
                const gate = probe.gate;
                if (gate) {
                    probe.gate = undefined;
                    gate.entered();
                    await gate.wait;
                }
            }
            return actual.readFile(...args);
        }
    };
});
vi.mock('../src/archive-read-internal.ts',async load=>{const actual=await load<typeof import('../src/archive-read-internal.ts')>();return {...actual,readArchiveHistoryPrefix(backend:object,proof:object){probe.prefixLookups++;const result=actual.readArchiveHistoryPrefix(backend,proof);if(probe.prefixAudit&&result.kind==='available'){
 probe.prefixCapture={backend,proof};let traps=0,called=0;const hostile=new Proxy({},{get(){traps++;throw Error('get')},getPrototypeOf(){traps++;throw Error('prototype')},ownKeys(){traps++;throw Error('keys')}});
 probe.prefixAuditResults.push(actual.readArchiveHistoryPrefix(backend,{}).kind,actual.readArchiveHistoryPrefix(backend,{...proof}).kind,actual.readArchiveHistoryPrefix({...backend},proof).kind,actual.readArchiveHistoryPrefix(probe.otherBackend!,proof).kind,actual.readArchiveHistoryPrefix(backend,hostile).kind,traps,Object.isFrozen(result.prefix),Object.keys(result.prefix).sort());
 let twice=false,foreign=false;try{actual.associateArchiveHistoryPrefixReader(backend,()=>{called++;return result.prefix})}catch{twice=true}try{actual.associateArchiveHistoryPrefixReader({...backend},()=>{called++;return result.prefix})}catch{foreign=true};probe.prefixAuditResults.push(twice,foreign,called);
 }return result}}})
vi.mock('../src/restored-context-internal.ts', async (load) => {
    const actual = await load<typeof import('../src/restored-context-internal.ts')>();
    return {
        ...actual, associateRestoredContextAcquisition(coordinator: object, ports: Parameters<typeof actual.associateRestoredContextAcquisition>[1]) {
            return actual.associateRestoredContextAcquisition(coordinator, {
                assertAdmission: ports.assertAdmission.bind(ports), async acquire(id) {
                    const read = await ports.acquire(id), gate = probe.replyGate;
                    if (gate) {
                        probe.replyGate = undefined;
                        gate.entered(read);
                        await gate.wait;
                    }
                    return read;
                }
            });
        }
    };
});
vi.mock('@i-harness/core-session', async (load) => {
    const actual = await load<typeof import('@i-harness/core-session')>();
    return {
        ...actual, projectConversation(...args: Parameters<typeof actual.projectConversation>) {
            if (probe.resident)
                throw Error('hidden public projection replay');
            return actual.projectConversation(...args);
        }, readConversationState(...args: Parameters<typeof actual.readConversationState>) {
            if (probe.resident)
                throw Error('hidden public state replay');
            return actual.readConversationState(...args);
        }, createManagedSessionState(...args: Parameters<typeof actual.createManagedSessionState>) {
            probe.views++;
            if (!probe.allowPublic)
                throw Error('hidden public view construction');
            return actual.createManagedSessionState(...args);
        }
    };
});
vi.mock('../../core-session/src/conversation/state.ts', async (load) => {
    const actual = await load<typeof import('../../core-session/src/conversation/state.ts')>();
    return {
        ...actual, createConversationStateIndex() {
            const original = actual.createConversationStateIndex();
            return {
                ...original, stage(...args: Parameters<typeof original.stage>) {
                    const staged = original.stage(...args);
                    return {
                        commit() {
                            if (probe.failInstall) {
                                probe.failInstall = false;
                                throw Error('held restored install failure');
                            }
                            staged.commit();
                        }
                    };
                }
            };
        }
    };
});
vi.mock('@i-harness/core-session/internal/restoration', async (load) => {
    const actual = await load<typeof import('@i-harness/core-session/internal/restoration')>();
    return {
        ...actual, async restoreManagedConversation(...args: Parameters<typeof actual.restoreManagedConversation>) {
            probe.sources.push(args[0]);
            return actual.restoreManagedConversation(...args);
        }
    };
});
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts', async (load) => {
    const actual = await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();
    return {
        ...actual, createFactJournalBackend(...args: Parameters<typeof actual.createFactJournalBackend>) {
            const backend = actual.createFactJournalBackend(...args), append = backend.appendOwnedBatch.bind(backend);
            return {
                ...backend, async readJournalPrefix(...args:Parameters<typeof backend.readJournalPrefix>){probe.prefixReads++;return backend.readJournalPrefix(...args)}, async appendOwnedBatch(...args: Parameters<typeof append>): Promise<Awaited<ReturnType<typeof append>>> {
                    probe.appends++;
                    const outcome = await append(...args);
                    return probe.unknown && outcome.kind === 'committed' ? { kind: 'unknown', key: args[3].key } : outcome;
                }
            };
        }
    };
});
import type { OriginalConversationRestorationSource } from '@i-harness/core-session/internal/restoration';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { acquireRestoredContext } from '../src/restored-context-internal.ts';
import { captureContextSnapshot } from '../../context-engine/src/index.ts';
import { captureRestoredContextSnapshot } from '../../context-engine/src/snapshot/build.ts';
import type { SessionCoordinator } from '../src/index.ts';
const coordinators: SessionCoordinator[] = [];
afterEach(async () => {
    probe.resident = false;
    probe.gate = undefined;
    probe.replyGate = undefined;
    probe.path = '';
    probe.allowPublic = false;
    probe.unknown = false;
    probe.failInstall = false;
    probe.sources = [];probe.prefixAudit=false;probe.prefixCapture=undefined;probe.prefixAuditResults=[];probe.otherBackend=undefined;
    for (const c of coordinators.splice(0))
        await c.close();
});
const input = { ownerSessionId: 'owner', surface: { systemPrompt: 'system', tools: [] } };
async function fixture() {
    probe.views = 0;
    probe.fullReads = 0;
    probe.appends = 0;probe.prefixReads=0;probe.prefixLookups=0;
    probe.sources = [];
    const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'restored-context-')), backend = createJsonlBackend(root), c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true }, acquireRetryMs: 1, acquireDeadlineMs: 40 }, taskDocumentStorageContract);
    coordinators.push(c);
    await c.create({ sessionId: 'owner' });
    await c.append('owner', [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'task' }, { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'OLD-BODY-'.repeat(1000) }, { type: 'step/end', seq: 4 }, { type: 'step/start', seq: 5 }, { type: 'tool/call', seq: 6, callId: 'c', name: 'read', args: {} }, { type: 'assistant/message', seq: 7, text: 'tail' }, { type: 'tool/result', seq: 8, callId: 'c', name: 'read', output: 'PRUNED-BODY-'.repeat(1000) }, { type: 'step/end', seq: 9 }, { type: 'turn/end', seq: 10 }, { type: 'compaction/replacement', version: 1, seq: 11, replacementId: 'r', text: 'summary', coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }], insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } }, { type: 'compaction/prune', version: 1, seq: 12, pruned: [{ callId: 'c', head: 'head', tail: 'tail', removedBytes: 11000 }] }]);
    return { root, backend, c };
}
it('actual private original entry reaches context capture without public view and retains only current payload after transient Task14 proof', async () => {
    const f = await fixture(), expected = captureContextSnapshot((await f.c.snapshot!('owner')).session, input);
    probe.path = join(f.root, 'owner.jsonl');
    const read = await acquireRestoredContext(f.c, 'owner');
    expect(probe.views).toBe(0);
    expect(probe.fullReads).toBeGreaterThan(0);expect(probe.prefixReads).toBe(0);expect(probe.prefixLookups).toBe(1);expect(await acquireRestoredContext(f.c,'owner')).toBe(read);expect(probe.prefixLookups).toBe(1);
    const originalSource = probe.sources[0] as OriginalConversationRestorationSource;
    await expect(originalSource.readEvent(3)).rejects.toThrow('CONVERSATION_PAYLOAD_NOT_PREPARED');
    await expect(originalSource.consume(async () => {
        throw Error('retained historical body');
    })).rejects.toThrow('CONVERSATION_PAYLOAD_NOT_PREPARED');
    probe.resident = true;
    const before = probe.fullReads, lease = await read.prepare();
    expect(captureRestoredContextSnapshot(lease, input)).toEqual(expected);
    expect(() => lease.preparedEvent(3)).toThrow('CONVERSATION_PAYLOAD_NOT_PREPARED');
    expect(() => lease.preparedEvent(8)).toThrow('CONVERSATION_PAYLOAD_NOT_PREPARED');
    expect(JSON.stringify(lease.preparedResult(8))).not.toContain('PRUNED-BODY-');
    expect(probe.fullReads).toBe(before);
    await lease.settle();
    const second = await read.prepare();
    expect(captureRestoredContextSnapshot(second, input)).toEqual(expected);
    await second.settle();
    expect(probe.fullReads).toBe(before);
    expect(probe.views).toBe(0);
    probe.resident = false;
    await f.c.close();
    expect(f.c.ownerOf('owner')).toBe(false);
    await expect(read.prepare()).rejects.toThrow();
});
it('close across original private acquisition refuses publication and joins its partial entry resources', async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    probe.path = join(f.root, 'owner.jsonl');
    probe.gate = { entered: () => entered.resolve(), wait: release.promise };
    const pending = acquireRestoredContext(f.c, 'owner');
    void pending.catch(() => {
    });
    await entered.promise;
    let closed = false;
    const closing = f.c.close().then(() => {
        closed = true;
    });
    void closing.catch(() => {
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await expect(pending).rejects.toThrow();
    await closing;
    expect(f.c.ownerOf('owner')).toBe(false);
    expect(probe.views).toBe(0);
});
it('original committed-unknown append retains its batch and installs restored folds exactly once on reconciliation', async () => {
    const f = await fixture(), read = await acquireRestoredContext(f.c, 'owner'), old = await read.prepare();
    probe.allowPublic = true;
    const document = await f.c.openManagedDocument('owner');
    expect(probe.views).toBe(1);
    const before = probe.appends;
    probe.unknown = true;
    const outcome = await document.metadata.admit({ type: 'plan/mode', mode: 'on' });
    expect(outcome.kind).toBe('unknown');
    const observable=Object.getOwnPropertyDescriptor(document,'assertObservable')!;Object.defineProperty(document,'assertObservable',{...observable,value(){}});
    const originalPendingRefused=await read.prepare().then(async lease=>{await lease.settle();return false},()=>true);Object.defineProperty(document,'assertObservable',observable);
    expect(probe.appends).toBe(before + 1);
    await expect(read.prepare()).rejects.toThrow();
    expect(captureRestoredContextSnapshot(old, input)).toMatchObject({ kind: 'unsupported' });
    if (outcome.kind !== 'unknown')
        throw Error('unknown original frame required');
    probe.unknown = false;
    const recovered = await document.reconcile(outcome.key);
    expect(recovered.kind).toBe('committed');
    expect(probe.appends).toBe(before + 1);
    if (recovered.kind !== 'committed')
        throw Error('original receipt required');
    expect(recovered.receipt.key).toEqual(outcome.key);
    expect(recovered.seqs).toEqual([13]);
    expect(document.view.events.filter(e => e.type === 'plan/mode')).toHaveLength(1);
    const current = await read.prepare();
    expect(captureRestoredContextSnapshot(current, input)).toEqual(captureContextSnapshot(document.view, input));
    expect(() => old.assertCurrent()).toThrow();
    await old.settle();
    await current.settle();
    const again = await document.reconcile(outcome.key);
    expect(again.kind).toBe('not-issued');
    expect(probe.appends).toBe(before + 1);
    const active = await document.agent.auditAssistant({ type: 'assistant/message', text: 'new active body' });
    expect(active.kind).toBe('committed');
    const live = await read.prepare();
    expect(originalPendingRefused).toBe(true);
    expect(live.preparedEvent(14)).toBe(document.view.events[14]);
    expect(captureRestoredContextSnapshot(live, input)).toEqual(captureContextSnapshot(document.view, input));
    await live.settle();
});
it('later original rewind invalidates the lease and preserves monotone replacement selection and coordinates', async () => {
    const f = await fixture(), read = await acquireRestoredContext(f.c, 'owner'), old = await read.prepare();
    probe.allowPublic = true;
    const document = await f.c.openManagedDocument('owner');
    const outcome = await document.compaction.commit([{ type: 'rewind/point', version:1, targetTurn:0, anchorSeq:11, mode:'conversation', fileOps:[] }]);
    expect(outcome.kind).toBe('committed');
    expect(() => old.assertCurrent()).toThrow();
    const current = await read.prepare(), captured = captureRestoredContextSnapshot(current, input);
    expect(captured).toEqual(captureContextSnapshot(document.view, input));
    expect(JSON.stringify(captured)).not.toContain('OLD-BODY-');
    await current.settle();
    await old.settle();
});
it('durable append plus restored-fold installation failure retains the same original receipt for retry', async () => {
    const f = await fixture(), read = await acquireRestoredContext(f.c, 'owner'), old = await read.prepare();
    probe.allowPublic = true;
    const document = await f.c.openManagedDocument('owner'), before = probe.appends;
    probe.failInstall = true;
    const outcome = await document.metadata.admit({ type: 'plan/mode', mode: 'on' });
    expect(outcome.kind).toBe('recovery-required');
    expect(probe.appends).toBe(before + 1);
    await expect(read.prepare()).rejects.toThrow();
    expect(captureRestoredContextSnapshot(old, input)).toMatchObject({ kind: 'unsupported' });
    if (outcome.kind !== 'recovery-required')
        throw Error('retained installation receipt required');
    const recovered = await document.reconcile(outcome.receipt.key);
    expect(recovered.kind).toBe('committed');
    if (recovered.kind !== 'committed')
        throw Error('same receipt recovery required');
    expect(recovered.receipt).toEqual(outcome.receipt);
    expect(probe.appends).toBe(before + 1);
    expect(document.view.events.filter(event => event.type === 'plan/mode')).toHaveLength(1);
    const current = await read.prepare();
    expect(captureRestoredContextSnapshot(current, input)).toEqual(captureContextSnapshot(document.view, input));
    await current.settle();
    await old.settle();
});
import { readFile, writeFile } from 'node:fs/promises';
it.each(['before', 'after'] as const)('complete corruption %s the effective cut cannot be hidden by restoration', async (position) => {
    const f = await fixture(), path = join(f.root, 'owner.jsonl'), raw = await readFile(path, 'utf8'), changed = position === 'before' ? raw.replace('OLD-BODY-', 'BAD-BODY-') : raw.replace('"head":"head"', '"head":"bad!"');
    expect(changed).not.toBe(raw);
    await writeFile(path, changed);
    await expect(acquireRestoredContext(f.c, 'owner')).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(changed);
    expect(probe.views).toBe(0);
});
it('failed postawait publication admission disposes the actual acquired read through its original entry', async () => {
    const f = await fixture(), entered = Promise.withResolvers<unknown>(), release = Promise.withResolvers<void>();
    probe.replyGate = { entered: read => entered.resolve(read), wait: release.promise };
    const pending = acquireRestoredContext(f.c, 'owner');
    void pending.catch(() => {
    });
    const original = await entered.promise as {
        prepare(): Promise<unknown>;
    };
    try {
        await f.c.close();
    }
    finally {
        release.resolve();
    }
    await expect(pending).rejects.toMatchObject({ reason: 'revoked' });
    expect(f.c.ownerOf('owner')).toBe(false);
    await expect(original.prepare()).rejects.toThrow();
    expect(probe.views).toBe(0);
});
import { readRestoredGenerations } from '@i-harness/core-session/internal/restoration'
it('existing live generation facts retain exact original object identity through private restoration',async()=>{
 const f=await fixture();probe.allowPublic=true;const document=await f.c.openManagedDocument('owner'),action=document.beginAction();try{const admission=await document.inputs.admit({type:'agent/input/admitted',version:1,inputId:'live-input',text:'live task',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}});expect(admission.kind).toBe('committed');const outcome=await action.captureGeneration([{type:'context/action',version:1,op:'open',ownerSessionId:'owner',actionId:'live-action',purpose:'main',origin:{kind:'input',seq:13},startedAt:100,expiresAt:10000,trustedAt:100}],()=>true).admit();expect(outcome.kind).toBe('committed');const original=document.view.events.at(-1)!,read=await acquireRestoredContext(f.c,'owner'),lease=await read.prepare();expect(readRestoredGenerations(lease)?.[0]?.opened).toBe(original);expect(captureRestoredContextSnapshot(lease,input)).toEqual(captureContextSnapshot(document.view,input));await lease.settle();expect(()=>readRestoredGenerations(lease)).toThrow('CONVERSATION_PREPARATION_EXPIRED')}finally{action.finish()}
})
it('retiring a private read cannot block the original already-captured required writer drain',async()=>{
 const f=await fixture(),read=await acquireRestoredContext(f.c,'owner');probe.allowPublic=true;const document=await f.c.openManagedDocument('owner'),action=document.beginAction();try{const call=await action.facts.tools.call({type:'tool/call',callId:'late',name:'read',args:{}});expect(call.kind).toBe('committed');const source=action.registerSettlementSource(async()=>{});source.tools.captureResult({type:'tool/result',callId:'late',name:'read',output:'required late outcome'});await f.c.close();expect(f.c.ownerOf('owner')).toBe(false);const restored=await f.backend.read('owner');expect(restored.events.filter(event=>event.type==='tool/result'&&event.callId==='late')).toHaveLength(1);await expect(read.prepare()).rejects.toThrow()}finally{action.finish()}
})
it('qualified prefix metadata is original-proof-only, immutable, once-associated and unavailable after original retirement',async()=>{
 const f=await fixture();probe.otherBackend=createJsonlBackend(join(f.root,'other-backend'));probe.prefixAudit=true;const read=await acquireRestoredContext(f.c,'owner');expect(probe.prefixAuditResults).toEqual(['unavailable','unavailable','unavailable','unavailable','unavailable',0,true,['bodyBytes','eventCount','prefixDigest'],true,true,0]);expect(probe.prefixLookups).toBe(1);expect(probe.prefixReads).toBe(0);const original=probe.prefixCapture!;const raw=await vi.importActual<typeof import('../src/archive-read-internal.ts')>('../src/archive-read-internal.ts');expect(raw.readArchiveHistoryPrefix(original.backend,original.proof)).toEqual({kind:'unavailable'});const again=await acquireRestoredContext(f.c,'owner');expect(again).toBe(read);expect(probe.prefixLookups).toBe(1);probe.prefixCapture=undefined
})
