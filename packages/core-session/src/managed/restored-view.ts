import { createExecutionCodeState } from '../projection/execution-code-state.ts';
import type { OriginalExecutionFoldFactory, OriginalExecutionFoldSink } from './execution-types.ts';
import { types } from 'node:util';
import {propagateOriginalCurrentnessReader,bindOriginalCurrentnessMethod,runOpaqueCurrentnessRead,originalCurrentnessFactoryMatches} from './currentness-guards.ts';
import { historyTurns } from '../conversation/history/turns.ts';
import { selectSeedHistoryFromStructure } from '../conversation/seed-selection.ts';
import { captureRewrites,type ConversationRewriteDraft,type ConversationCandidate } from '../conversation/candidate.ts';
import {extendConversationSourceCoordinates} from '../conversation/sources.ts';
import {extendPruneDependencyView} from '../projection/pruning.ts';
import { captureOriginalRestorationSource } from './restoration-source.ts';
import type { SessionEventView, EncodedFactBatch, FactReceipt } from './types.ts';
import type { ConversationPayloadCapture } from '../conversation/payload.ts';
import { preparePrunedResultProjection } from '../conversation/payload.ts';
import type { ConversationProjection } from '../conversation/types.ts';
import type { PreparedConversationArchive, PreparedPrunedResult, PreparedResultProjection } from '../conversation/restoration-types.ts';
import type { OriginalConversationRestorationSource } from '../conversation/restoration-input.ts';
import { createConversationValidationScan, takeConversationValidationScan, readConversationDeliveries, readConversationGenerations,prepareConversationAppend,hasConversationToolCall } from '../conversation/validation.ts';
import { createManagedIntakeIndex } from './intake-index.ts';
import { prepareSessionEventWithDependencies } from '../events/intake.ts';
import { freezeJsonData, isStrictFactData } from './capture.ts';
import { resolveFactGroupWithDependencies,type CapturedFactGroup } from './groups.ts';
import { validateDeliveryFrame } from '../conversation/delivery.ts';
import { createConversationSourceCoordinates, archiveConversationSources, retainConversationSourceCoordinates } from '../conversation/sources.ts';
import { createConversationStateIndex, readIndexedConversationState, type ConversationStateRead } from '../conversation/state.ts';
import { createContextStateIndex } from '../projection/context.ts';
import { createPruneDependencyIndex, preparePruneSubstitutes, selectPruneDependencies, retainPruneDependencyView } from '../projection/pruning.ts';
import { historyVisibility } from '../conversation/history/visibility.ts';
import {sameManagedArtifactRef} from '../results/seed-refs.ts';
import { renderConversationItems } from '../conversation/render-items.ts';
import {createManagedIndexedView} from './view.ts';
function failure(code: string): never {
    throw Object.assign(new Error(code), { code });
}
type Candidate = {
    source: OriginalConversationRestorationSource;
    owner: object;
    sessionId: string;
    index: ReturnType<typeof takeConversationValidationScan>;
    sources: ReturnType<typeof createConversationSourceCoordinates>;
    state: ReturnType<typeof createConversationStateIndex>;
    context: ReturnType<typeof createContextStateIndex>;
    prune: ReturnType<typeof createPruneDependencyIndex>;
    intake:ReturnType<typeof createManagedIntakeIndex>;
    code:ReturnType<typeof createExecutionCodeState>;
    fold?: Pick<OriginalExecutionFoldSink,'appendValidated'|'finishRestore'|'snapshot'> & {assertHealthy():void;views:Readonly<Partial<Record<import('./execution-types.ts').ExecutionFoldName,(prefix:Readonly<import('./types.ts').JournalPrefix>)=>unknown>>>};
    installed: boolean;
    retired: boolean;
};
const candidates = new WeakMap<object, Candidate>();
type TaskSelection = Extract<import('../conversation/seed-types.ts').SeedSelection, {kind: 'all' | 'last-turns'}>;
type TaskHistoryPrepared = {kind:'refused'; reason: import('../conversation/seed-types.ts').SeedRefusal} | {kind:'selected'; selected: Extract<ReturnType<typeof selectSeedHistoryFromStructure>, {kind:'selected'}>; archive: import('../conversation/archive.ts').ConversationEventArchive; manifest: Extract<SessionEventView,{type:'conversation/seed-manifest'}> | undefined; header: import('./types.ts').SessionView['header']; formatVersion: number; coordinates: import('../conversation/restoration-types.ts').ConversationSourceCoordinateView; substitutes: Awaited<ReturnType<typeof preparePruneSubstitutes>>};
const taskHistorySources = new WeakMap<object, { sessionId: string; select: (selection: TaskSelection) => Promise<TaskHistoryPrepared> }>();
export function readOriginalRestoredTaskHistory(source: object) {
    const entry = taskHistorySources.get(source);
    if (!entry) failure('CONVERSATION_TASK_HISTORY_INVALID');
    return entry;
}
type Preparation = {
    candidate: Candidate;
    current(): void;
    archive: {
        length: number;
        get(index: number): SessionEventView;
    };
    pruned: Map<number, PreparedPrunedResult>;
    substitutes: Awaited<ReturnType<typeof preparePruneSubstitutes>>;
    coordinates: ReturnType<Candidate['sources']['read']>;
    state: object;
};
const preparations = new WeakMap<object, Preparation>();
/** Full validation is original scan/finish; the candidate keeps no source array. */
export async function restoreManagedConversation(input: OriginalConversationRestorationSource, owner: object, sessionId: string, foldFactory?: OriginalExecutionFoldFactory): Promise<object> {
    const source = captureOriginalRestorationSource(input);
    source.assertCurrent();
    const supplied = foldFactory?.(Object.freeze({sessionId, seedLength: source.header?.seedLength ?? 0, formatVersion: source.formatVersion}));
    if(supplied&&types.isProxy(supplied))throw TypeError('Original fold must not be a proxy');
    const validator = supplied && Object.getOwnPropertyDescriptor(supplied, 'validateSnapshot')?.value;
    if (supplied && typeof validator !== 'function') throw TypeError('Original fold snapshot validator required');
    // Capture once. A callback that returns before its work is acknowledged
    // cannot later make this candidate usable, even if its promise settles.
    let foldFailure: TypeError | undefined;
    const refuse = (result: unknown): never => {
        const error = foldFailure ??= new TypeError('Synchronous original fold callback required', {cause: result});
        // Retain a late rejection as the failure cause; never promote it to ACK.
        void Promise.resolve(result).catch(cause => { error.cause = cause; });
        throw error;
    };
    let checkViews=()=>{};
    const originalFactory=!!(supplied&&foldFactory&&originalCurrentnessFactoryMatches(foldFactory,supplied,'snapshot'));
    const snapshotRead=supplied&&originalFactory?bindOriginalCurrentnessMethod(supplied,'snapshot'):undefined,validatorRead=supplied&&originalFactory?bindOriginalCurrentnessMethod(supplied,'validateSnapshot'):undefined;
    const synchronous = (method: (...args: any[]) => unknown, snapshot = false) => (...args: any[]) => {
        if (foldFailure) throw foldFailure;
        checkViews();
        let result:unknown;
        try { result = method(...args); } catch(cause) { foldFailure ??= new TypeError('Original fold callback failed',{cause}); throw foldFailure; }
        checkViews();
        if (snapshot) {
            if (!isStrictFactData(result) || Object.getOwnPropertyDescriptor(supplied!, 'validateSnapshot')?.value !== validator) refuse(result);
            let valid: unknown;
            try { valid = validatorRead?validatorRead(result):runOpaqueCurrentnessRead(source.assertCurrent,()=>Reflect.apply(validator,supplied,[result])); }
            catch (cause) { foldFailure ??= new TypeError('Synchronous original fold snapshot validation failed', {cause}); throw foldFailure; }
            if (valid !== true) refuse(valid);
            if (Object.getOwnPropertyDescriptor(supplied!, 'validateSnapshot')?.value !== validator) refuse(result);
            checkViews();
        } else if (result !== undefined) refuse(result);
        return result;
    };
    const viewsField=supplied&&Object.getOwnPropertyDescriptor(supplied,'views');
    if(viewsField&&!('value'in viewsField))throw TypeError('Original fold views must be own data');
    const views=viewsField?.value;
    if(views!==undefined&&(!views||typeof views!=='object'||types.isProxy(views)||Array.isArray(views)||Reflect.ownKeys(views).some(key=>key!=='todo'&&key!=='goal'&&key!=='title')))throw TypeError('Invalid original fold views');
    const capturedFields=views?Object.getOwnPropertyDescriptors(views):undefined;
    const viewMethodChecks:Array<()=>void>=[];
    checkViews=()=>{const current=Object.getOwnPropertyDescriptor(supplied!,'views');if(!!current!==!!viewsField||current&&(!('value'in current)||current.value!==views))refuse('Original fold views changed');if(views){const keys=Reflect.ownKeys(views);if(keys.length!==Reflect.ownKeys(capturedFields!).length||keys.some(key=>{const before=Object.getOwnPropertyDescriptor(capturedFields!,key)?.value,after=Object.getOwnPropertyDescriptor(views,key);return !before||!after||!('value'in before)||!('value'in after)||before.value!==after.value}))refuse('Original fold views changed')}for(const check of viewMethodChecks)check()};
    const named:Partial<Record<import('./execution-types.ts').ExecutionFoldName,(prefix:Readonly<import('./types.ts').JournalPrefix>)=>unknown>>={};
    for(const name of ['todo','goal','title'] as const){
      const field=views&&Object.getOwnPropertyDescriptor(views,name);if(!field)continue;
      if(!('value'in field)||!field.value||typeof field.value!=='object'||types.isProxy(field.value)||Array.isArray(field.value)||Reflect.ownKeys(field.value).some(key=>key!=='snapshot'&&key!=='validateSnapshot'))throw TypeError('Original fold view required');
      const view=field.value,snapshot=Object.getOwnPropertyDescriptor(view,'snapshot'),validate=Object.getOwnPropertyDescriptor(view,'validateSnapshot');
      if(!snapshot||!('value'in snapshot)||typeof snapshot.value!=='function'||types.isProxy(snapshot.value)||types.isAsyncFunction(snapshot.value)||!validate||!('value'in validate)||typeof validate.value!=='function'||types.isProxy(validate.value)||types.isAsyncFunction(validate.value))throw TypeError('Original fold view methods required');
      viewMethodChecks.push(()=>{if(Object.getOwnPropertyDescriptor(view,'snapshot')?.value!==snapshot.value||Object.getOwnPropertyDescriptor(view,'validateSnapshot')?.value!==validate.value)refuse('Original fold view changed')});
      const checkView=()=>checkViews();
      const read=originalFactory?bindOriginalCurrentnessMethod(view,'snapshot'):undefined,validation=originalFactory?bindOriginalCurrentnessMethod(view,'validateSnapshot'):undefined;
      named[name]=(prefix)=>{if(foldFailure)throw foldFailure;try{checkView();const result=read?read(prefix):runOpaqueCurrentnessRead(source.assertCurrent,()=>Reflect.apply(snapshot.value,view,[prefix]));if(!isStrictFactData(result))refuse(result);checkView();const valid=validation?validation(result):runOpaqueCurrentnessRead(source.assertCurrent,()=>Reflect.apply(validate.value,view,[result]));if(valid!==true)refuse(valid);checkView();if(!isStrictFactData(result))refuse(result);return result}catch(cause){foldFailure??=new TypeError('Original fold view failed',{cause});throw foldFailure}};
      if(read&&validation)propagateOriginalCurrentnessReader(view,'snapshot',named,name,[],[[view,'validateSnapshot']]);
    }
    const fold = supplied && Object.freeze({
        assertHealthy(){if(foldFailure)throw foldFailure;checkViews()},
        appendValidated: synchronous(supplied.appendValidated.bind(supplied)),
        finishRestore: synchronous(supplied.finishRestore.bind(supplied)),
        snapshot: synchronous(snapshotRead??supplied.snapshot.bind(supplied), true),
        views:Object.freeze(named),
    });
    if(fold&&snapshotRead&&validatorRead)propagateOriginalCurrentnessReader(supplied!,'snapshot',fold,'snapshot',[],[[supplied!,'validateSnapshot']]);
    const code = createExecutionCodeState(source.header,sessionId);
    let ordinal = 0;
    const scan = createConversationValidationScan({ formatVersion: source.formatVersion, header: { ...source.header, sessionId }, readEvent: source.readEvent.bind(source) });
    const sources = createConversationSourceCoordinates(), state = createConversationStateIndex(), context = createContextStateIndex(), prune = createPruneDependencyIndex(),intake=createManagedIntakeIndex();
    await source.consume(async (unit) => {
        source.assertCurrent();
        await scan.push(unit);
        source.assertCurrent();
        fold?.appendValidated(unit, ordinal);
        code.append(unit, ordinal);
        ordinal += unit.length;
        source.assertCurrent();
        sources.stage(unit).commit();
        state.stage(unit).commit();
        context.stage(unit).commit();
        prune.stage(unit).commit();
        intake.stage(unit,false).commit();
    });
    const index = takeConversationValidationScan(scan.finish());
    if (index.eventCount !== source.prefix.eventCount)
        failure('CONVERSATION_RESTORATION_PREFIX_MISMATCH');
    await source.settle();
    source.assertCurrent();
    fold?.finishRestore(source.prefix);
    source.assertCurrent();
    const candidate = Object.freeze({});
    candidates.set(candidate, { source, owner, sessionId, index, sources, state, context, prune,intake, code, fold, installed: false, retired: false });
    return candidate;
}
/** Original managed constructor alone consumes its exact owner's candidate. */
export function installRestoredManagedConversation(candidate: object, owner: object) {
    const record = candidates.get(candidate);
    if (!record || record.owner !== owner || record.installed || record.retired)
        failure('CONVERSATION_RESTORATION_CANDIDATE_INVALID');
    record.source.assertCurrent();
    record.installed = true;
    const owned = record;
    let revision = 0, installationBlocked = false;
    let resident: {
        revision: number;
        payload: PreparedPayload;
    } | undefined;
    const leases = new Set<PreparedConversationArchive>();
    const sourceCurrent = () => {
        if (owned.retired)
            failure('CONVERSATION_RESTORATION_RETIRED');
        owned.source.assertCurrent();
    };
    const check = () => {
        sourceCurrent();
        if (installationBlocked)
            failure('CONVERSATION_RESTORATION_RECOVERY_REQUIRED');
        owned.fold?.assertHealthy();
    };
    function appendStage(events:readonly SessionEventView[],validation:ReturnType<Candidate['index']['stage']>,discardValidation?:()=>void){
        const expected=revision,sources=owned.sources.stage(events),state=owned.state.stage(events),context=owned.context.stage(events),prune=owned.prune.stage(events),intake=owned.intake.stage(events);
        let installed=false,started=false,discarded=false,sourceDone=false,validationDone=false,sourcesDone=false,stateDone=false,contextDone=false,pruneDone=false,intakeDone=false,foldDone=false,foldFailed=false,codeDone=false;
        return {events,discard(){if(started)failure('CONVERSATION_RESTORATION_ISSUED_STAGE');discarded=true;discardValidation?.()},install(batch:EncodedFactBatch,receipt:FactReceipt){
            if(discarded)failure('CONVERSATION_RESTORATION_DISCARDED_STAGE');
            if(installed)return;
            sourceCurrent();if(revision!==expected)failure('CONVERSATION_RESTORATION_STALE_SUFFIX');started=true;installationBlocked=true;
            if(!sourceDone){if(batch.key.firstSeq!==owned.index.eventCount||batch.key.count!==events.length)failure('CONVERSATION_RESTORATION_PREFIX_MISMATCH');owned.source.appendCommitted(batch,receipt);sourceDone=true}
            if(!validationDone){validation.commit();validationDone=true}
            if(foldFailed)failure('CONVERSATION_RESTORATION_RECOVERY_REQUIRED');
            if(!foldDone){try{owned.fold?.appendValidated(events,batch.key.firstSeq);owned.fold?.finishRestore(owned.source.prefix);foldDone=true}catch(error){foldFailed=true;throw error}sourceCurrent()}
            if(!codeDone){owned.code.append(events,batch.key.firstSeq);codeDone=true}
            if(!sourcesDone){sources.commit();sourcesDone=true}
            if(!stateDone){state.commit();stateDone=true}
            if(!contextDone){context.commit();contextDone=true}
            if(!pruneDone){prune.commit();pruneDone=true}
            if(!intakeDone){intake.commit();intakeDone=true}
            revision++;resident=undefined;installed=true;installationBlocked=false;
        }};
    }
    const result = {
        /** Structural selection matches native recovery: local ref facts, rewind only. */
        recentNativeRecoverySelection(){check();const facts=owned.index.resultFacts(),visibility=historyVisibility(facts),selected: {ordinal:number;ref:import('../conversation/selected-results-types.ts').LegacyRef}[]=[];for(let i=facts.length-1;i>=0&&selected.length<12;i--){const fact=facts[i]!;if(fact.type==='context/result-ref'&&fact.legacyResult&&visibility.branch(fact))selected.push({ordinal:fact.index,ref:fact.legacyResult})}selected.reverse();return selected},
        reviewerOrdinals(){check();const facts=owned.index.resultFacts(),count=owned.index.eventCount;let latestUser:number|undefined;for(let i=facts.length-1;i>=0;i--)if(facts[i]!.type==='user/message'){latestUser=facts[i]!.index;break}return {tail:Array.from({length:Math.min(12,count)},(_,index)=>count-Math.min(12,count)+index),latestUser}},
        workflowJobOrdinals(documentIds:readonly string[]){check();const jobs=new Map<string,number|undefined>();for(const id of documentIds)jobs.set(id,undefined);for(const fact of owned.index.resultFacts())if(fact.type==='job/status'&&fact.jobId)jobs.set(fact.jobId,fact.index);return [...jobs].slice(-200).flatMap(([id,ordinal])=>ordinal===undefined?[]:[{id,ordinal}])},
        workflowLastStepOrdinal(fromSeq:number){check();const facts=owned.index.resultFacts();for(let i=facts.length-1;i>=fromSeq;i--)if(facts[i]!.type==='step/end')return facts[i]!.index;return undefined},
        /** Structural selection only; payload remains in the held writer. */
        taskResultOrdinal(taskId:string) {
            check();const facts=owned.index.resultFacts(),visibility=historyVisibility(facts)
            for(let i=facts.length-1;i>=0;i--){const fact=facts[i]!;if(fact.type==='subagent/end'&&fact.taskId===taskId&&visibility.branch(fact))return fact.index}
            return undefined
        },
        /** Capture structural facts synchronously under the original held writer. */
        reserveTaskHistory(read: (index: number) => Promise<SessionEventView>, assertCurrent: () => void) {
            check(); assertCurrent();
            const facts = owned.index.resultFacts().slice(), history = owned.index.history(), count = owned.index.eventCount;
            const turns = historyTurns({length: facts.length, get: index => facts[index]!});
            const visibility = historyVisibility(facts);
            const legacy = turns.ambiguous ? 'unavailable' as const : facts.some(fact => fact.type === 'context/result-ref' && visibility.content(fact)) ? 'visible' as const : 'absent' as const;
            const header = owned.source.header, formatVersion = owned.source.formatVersion;
            const manifestIndex = facts.findIndex(fact => fact.type === 'conversation/seed-manifest');
            const current = () => { sourceCurrent(); assertCurrent(); };
            const coordinates = retainConversationSourceCoordinates(owned.sources.read(), current), prune = retainPruneDependencyView(owned.prune.read(), current);
            const select = async (selection: TaskSelection) => {
                current();
                const manifestEvent = manifestIndex < 0 ? undefined : await read(manifestIndex);
                current();
                if (manifestEvent && manifestEvent.type !== 'conversation/seed-manifest') failure('CONVERSATION_RESTORATION_DEPENDENCY_MISMATCH');
                if (turns.ambiguous) return {kind: 'refused' as const, reason: 'ambiguous-boundary' as const};
                const selected = selectSeedHistoryFromStructure({history, turns}, selection, {last: turns.total}, index => facts[index]!.type, manifestEvent);
                if (selected.kind === 'refused') return selected;
                const wanted = new Set<number>();
                for (const item of selected.groups.flatMap(group => group.items)) {
                    wanted.add(item.establishmentIndex);
                    if (item.admissionIndex !== undefined) wanted.add(item.admissionIndex);
                    if (item.imageAdmissionIndex !== undefined) wanted.add(item.imageAdmissionIndex);
                    for (const recipe of item.recipes) { if (recipe.index !== undefined) wanted.add(recipe.index); for (const index of recipe.calls ?? []) wanted.add(index); }
                    for (const call of item.calls) if (call.result) wanted.add(call.result.eventIndex);
                }
                const calls = new Set([...wanted].flatMap(index => facts[index]?.type === 'tool/result' && facts[index]?.callId ? [facts[index]!.callId!] : []));
                const substitutes = await preparePruneSubstitutes(prune, selectPruneDependencies(prune, calls), async index => { current(); const event = await read(index); current(); return event; });
                current();
                const full = new Map<number, SessionEventView>();
                if (manifestEvent) full.set(manifestIndex, manifestEvent);
                for (const index of wanted) { current(); const event = await read(index); current(); if (event.seq !== index) failure('CONVERSATION_RESTORATION_DEPENDENCY_MISMATCH'); full.set(index, event); }
                for (const event of [...full.values()]) if (event.type === 'user/message' && event.inputPreparation) {
                    const index = event.inputPreparation.resultSeq, result = full.get(index) ?? await read(index); current(); full.set(index, result);
                    if (result.type === 'agent/input/preparation' && !full.has(result.admissionSeq)) { full.set(result.admissionSeq, await read(result.admissionSeq)); current(); }
                }
                const archive = {length: count, get(index: number) { current(); const event = full.get(index); if (!event) failure('CONVERSATION_PAYLOAD_NOT_PREPARED'); return event; }};
                return {kind: 'selected' as const, selected, archive, manifest: manifestEvent, header, formatVersion, coordinates, substitutes};
            };
            const source = Object.freeze({});
            taskHistorySources.set(source, {sessionId: owned.sessionId, select});
            return {source, legacy, inheritedLegacyUnknown: header?.semanticSeed !== undefined};
        },
        codeState(){check();return owned.code.snapshot()},
        foldSnapshot(prefix:Readonly<import('./types.ts').JournalPrefix>){check();return owned.fold?.snapshot(prefix)},
        foldView(name:import('./execution-types.ts').ExecutionFoldName,prefix:Readonly<import('./types.ts').JournalPrefix>){check();return owned.fold?.views?.[name]?.(prefix)},
        hasFoldView(name:import('./execution-types.ts').ExecutionFoldName){check();return !!owned.fold?.views?.[name]},
        hasFold:!!owned.fold,
        compatibility(events:readonly SessionEventView[],owner:object){check();return createManagedIndexedView(events,owned.source.formatVersion,owned.source.header,owned.index,owner,owned.sessionId)},
        delivery(){check();return readConversationDeliveries(owned.index)!},
        intake:owned.intake,
        context:owned.context,
        generations(){check();return readConversationGenerations(owned.index)??[]},
        executionScalars(){check();return {semanticsStartSeq:owned.index.semanticsStartSeq,hasToolCallId:(id:string)=>{check();return hasConversationToolCall(owned.index,id)}}},
        uiScalars(){check();const facts=owned.index.resultFacts();return {hasConversationMessages:facts.some(f=>f.type==='user/message'||f.type==='assistant/message'),turnCount:facts.filter(f=>f.type==='turn/end').length,todosRevision:facts.filter(f=>f.type==='todo/write').length}},
        hasVisibleResultRef(candidate:Readonly<{kind:'legacy';id:string}|{kind:'managed';ref:import('../results/types.ts').ManagedArtifactRef}>){check();const facts=owned.index.resultFacts(),visibility=historyVisibility(facts);if(candidate.kind==='managed'&&owned.index.semanticSeedResultRefs().some(ref=>sameManagedArtifactRef(ref,candidate.ref)))return true;for(const fact of facts){if(!visibility.branch(fact))continue;if(candidate.kind==='legacy'){if(fact.legacyResult?.id===candidate.id)return true}else if(fact.resultDeclarations?.some(value=>sameManagedArtifactRef(value.ref,candidate.ref))||fact.terminalResultRefs?.some(ref=>sameManagedArtifactRef(ref,candidate.ref)))return true}check();return false},
        softReduction(){check();const facts=owned.index.resultFacts();const advances=(end:number)=>{const results=new Set<string>();let humanTurns=0,acceptedExchanges=0;for(let index=0;index<end;index++){const fact=facts[index]!;if(fact.type==='tool/result'&&fact.disposition!=='unknown'&&fact.callId)results.add(fact.callId);if(fact.type==='turn/end')humanTurns++}for(let index=0;index<end;index++){const fact=facts[index]!;if(fact.type==='model/exchange-accepted'&&fact.callSeqs?.every(seq=>facts[seq]?.type==='tool/call'&&results.has(facts[seq]!.callId!)))acceptedExchanges++}return {humanTurns,acceptedExchanges}};const current=advances(facts.length),last=facts.findLastIndex(fact=>['compaction/replacement','compaction/prune','compaction/end'].includes(fact.type)),prior=last<0?undefined:advances(last+1);return {state:owned.index.softReduction(owned.sessionId),...current,...prior?{sinceRewrite:{humanTurns:current.humanTurns-prior.humanTurns,acceptedExchanges:current.acceptedExchanges-prior.acceptedExchanges}}:{}}},
        get eventCount(){check();return owned.index.eventCount},
        get prefix(){check();return owned.source.prefix},
        get formatVersion(){check();return owned.source.formatVersion},
        get header(){check();return owned.source.header},
        needsPreparation() {
            check();
            return !resident || resident.revision !== revision;
        },
        // The held execution owner may supply its operation-local dependency
        // reader. The public archive facade never forwards an incoming reader.
        async prepare(readEvent?: (ordinal: number) => Promise<SessionEventView>): Promise<PreparedConversationArchive> {
            check();
            const expected = revision, current = () => {
                check();
                if (revision !== expected)
                    failure('CONVERSATION_PREPARATION_EXPIRED');
            };
            if (!resident || resident.revision !== revision) {
                let settleStarted = false;
                try {
                    const payload = await hydratePreparation(owned, current, undefined, readEvent);
                    settleStarted = true;
                    await owned.source.settle();
                    current();
                    resident = { revision, payload };
                }
                catch (primary) {
                    if (!settleStarted)
                        try {
                            await owned.source.settle();
                        }
                        catch (cleanup) {
                            throw new AggregateError([primary, cleanup], 'Conversation preparation and cleanup failed');
                        }
                    throw primary;
                }
            }
            return issuePreparation(owned, resident.payload, current, leases);
        },
        stageAppend(events: readonly SessionEventView[], readCurrentEvent: (index: number) => SessionEventView | undefined) {
            check();
            return appendStage(events,owned.index.stage(events,{readCurrentEvent}));
        },
        /** Only the original already-held writer constructs this reader. */
        async prepareWrite(groups:readonly CapturedFactGroup[],readEvent:(ordinal:number)=>Promise<SessionEventView>,assertCurrent:()=>void,rejectInvalidGroups=false){
            check();const expected=revision,available=new Map<number,SessionEventView>(),events:SessionEventView[]=[],members:{group:CapturedFactGroup;events:readonly SessionEventView[]}[]=[],rejected:{group:CapturedFactGroup;cause:unknown}[]=[];
            // The same staged validator commits while its own installation
            // fence is raised. Source/revision checks remain active there.
            const current=()=>{sourceCurrent();assertCurrent();if(expected!==revision)failure('CONVERSATION_RESTORATION_STALE_SUFFIX')};
            class Missing extends Error{constructor(readonly ordinal:number){super('Writer dependency not prepared')}}
            let readFailed=false;
            const read=async(ordinal:number)=>{try{current();let value=available.get(ordinal);if(!value){value=await readEvent(ordinal);current();if(!value||value.seq!==ordinal)failure('CONVERSATION_RESTORATION_DEPENDENCY_MISMATCH');available.set(ordinal,value)}return value}catch(error){readFailed=true;throw error}};
            try{
                for(const group of groups){
                    let resolved:ReturnType<typeof resolveFactGroupWithDependencies>;
                    try{for(;;){try{resolved=resolveFactGroupWithDependencies(group,{eventCount:owned.index.eventCount,readEvent(ordinal){if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=owned.index.eventCount)return undefined;const value=available.get(ordinal);if(!value)throw new Missing(ordinal);return value}},owned.index.eventCount+events.length);break}catch(error){if(!(error instanceof Missing))throw error;await read(error.ordinal)}}}
                    catch(cause){if(!rejectInvalidGroups||readFailed)throw cause;current();rejected.push({group,cause});continue}
                    const first=events.length;
                    for(const event of resolved){
                        const inputId=event.type==='user/message'?event.imageInputId:undefined;
                        const prior=inputId===undefined?undefined:events.findLast(value=>value.type==='agent/input/admitted'&&value.inputId===inputId);
                        const position=inputId===undefined||prior?undefined:owned.intake.admission(inputId);
                        if(position!==undefined)await read(position);
                        const normalized=freezeJsonData(prepareSessionEventWithDependencies(owned.source.formatVersion,event,event.seq!,id=>events.findLast(value=>value.type==='agent/input/admitted'&&value.inputId===id)??(owned.intake.admission(id)===undefined?undefined:available.get(owned.intake.admission(id)!))));
                        events.push(normalized);
                    }
                    members.push(Object.freeze({group,events:Object.freeze(events.slice(first))}));
                }
                current();Object.freeze(events);validateDeliveryFrame(events,owned.source.formatVersion);
                const validation=await prepareConversationAppend(owned.index,events,read,current);current();
                return {...appendStage(events,validation,validation.discard),members:Object.freeze(members),rejected:Object.freeze(rejected)};
            }finally{available.clear()}
        },
        async close() {
            owned.retired = true;
            resident = undefined;
            for (const lease of [...leases])
                await lease.settle();
            await owned.source.close();
            owned.intake.releasePayloads();owned.context.releasePayloads();
        },
    };
    for(const key of ['prefix','header','formatVersion'] as const)propagateOriginalCurrentnessReader(owned.source,key,result,key,[owned.source.assertCurrent]);
    if(owned.fold){
      propagateOriginalCurrentnessReader(owned.fold,'snapshot',result,'foldSnapshot',[owned.source.assertCurrent]);
      const views=owned.fold.views;
      if(views&&['todo','goal','title'].every(name=>Object.hasOwn(views,name)))for(const key of ['foldView','hasFoldView'] as const)propagateOriginalCurrentnessReader(views,'todo',result,key,[owned.source.assertCurrent],[[views,'goal'],[views,'title']]);
    }
    return result;
}
/** Paired projection/state from one live original preparation. No Session replay. */
export function readRestoredConversation(lease: PreparedConversationArchive, options: {
    ownerSessionId: string;
    capturePayload?: ConversationPayloadCapture;
}): {
    projection: ConversationProjection;
    state: ConversationStateRead;
} {
    const prepared = preparations.get(lease);
    if (!prepared)
        failure('CONVERSATION_PREPARATION_INVALID');
    prepared.current();
    const owned = prepared.candidate;
    if (options.ownerSessionId !== owned.sessionId)
        failure('CONVERSATION_RESTORATION_OWNER_MISMATCH');
    const projection = renderConversationItems(prepared.archive, owned.index.history(), { ...options, header: owned.source.header, sourceCoordinates: prepared.coordinates, pruneSubstitutes: prepared.substitutes, prunedResults: prepared.pruned });
    const sources = archiveConversationSources(prepared.archive, options.ownerSessionId, [], { header: owned.source.header, coordinates: prepared.coordinates, prunedResults: prepared.pruned });
    const state = readIndexedConversationState(prepared.state, projection, { sources, visibility: historyVisibility(owned.index.resultFacts()), delivery: readConversationDeliveries(owned.index)!, seedEnd: owned.source.header?.seedLength ?? 0 });
    prepared.current();
    return { projection, state };
}
type PreparedPayload = {
    full: Map<number, SessionEventView>;
    pruned: Map<number, PreparedPrunedResult>;
    substitutes: Awaited<ReturnType<typeof preparePruneSubstitutes>>;
    coordinates: ReturnType<Candidate['sources']['read']>;
    state: object;
};
async function hydratePreparation(owned: Candidate, current: () => void, prospective?:{history:ReturnType<Candidate['index']['history']>;coordinates:ReturnType<Candidate['sources']['read']>;prune:ReturnType<Candidate['prune']['read']>;read:(index:number)=>Promise<SessionEventView>}, readEvent?: (ordinal:number)=>Promise<SessionEventView>): Promise<PreparedPayload> {
    current();
    const history = prospective?.history??owned.index.history(), facts = owned.index.resultFacts(), coordinates = prospective?.coordinates??owned.sources.read(), pruneView = prospective?.prune??owned.prune.read();
    const wanted = new Set<number>(), callIds = new Set<string>();
    if (history.current)
        wanted.add(history.current.index);
    for (const item of history.items) {
        wanted.add(item.establishmentIndex);
        if (item.admissionIndex !== undefined)
            wanted.add(item.admissionIndex);
        if (item.imageAdmissionIndex !== undefined)
            wanted.add(item.imageAdmissionIndex);
        for (const recipe of item.recipes) {
            if (recipe.index !== undefined)
                wanted.add(recipe.index);
            for (const index of recipe.calls ?? [])
                wanted.add(index);
        }
    }
    for (const index of wanted) {
        const fact = facts[index];
        if (fact?.type === 'tool/result' && fact.callId)
            callIds.add(fact.callId);
    }
    const prunedCalls = selectPruneDependencies(pruneView, callIds);
    const read = async (index: number) => {
        current();
        const event = await (prospective?prospective.read(index):readEvent?readEvent(index):owned.source.readEvent(index));
        current();
        return event;
    };
    const substitutes = await preparePruneSubstitutes(pruneView, prunedCalls, read);
    const full = new Map<number, SessionEventView>(), pruned = new Map<number, PreparedPrunedResult>();
    for (const index of wanted) {
        const event = await read(index), substitute = event.type === 'tool/result' ? substitutes.get(event.callId) : undefined;
        if (event.type === 'tool/result' && substitute)
            pruned.set(index, preparePrunedResultProjection(event, substitute, { index: pruneView, callId: event.callId }));
        else
            full.set(index, event);
    }
    // Selected preparation text/provenance must use actual original bodies.
    for (const event of [...full.values()])
        if (event.type === 'user/message' && event.inputPreparation) {
            const resultIndex = event.inputPreparation.resultSeq;
            const result = full.get(resultIndex) ?? await read(resultIndex);
            full.set(resultIndex, result);
            if (result.type === 'agent/input/preparation') {
                const admission = result.admissionSeq;
                if (!full.has(admission))
                    full.set(admission, await read(admission));
            }
        }
    return { full, pruned, substitutes, coordinates, state: owned.state.read() };
}
function issuePreparation(owned: Candidate, payload: PreparedPayload, current: () => void, leases: Set<PreparedConversationArchive>): PreparedConversationArchive {
    const full = new Map(payload.full), pruned = new Map(payload.pruned), substitutes = new Map(payload.substitutes);
    let active = true;
    const assert = () => {
        if (!active)
            failure('CONVERSATION_PREPARATION_EXPIRED');
        current();
    };
    const eventAt = (index: number) => {
        assert();
        if (!full.has(index))
            failure('CONVERSATION_PAYLOAD_NOT_PREPARED');
        return full.get(index)!;
    };
    const archive = { length: owned.index.eventCount, get: eventAt };
    const lease: PreparedConversationArchive = Object.freeze({
        length: archive.length, assertCurrent: assert, preparedEvent(index: number) {
            if (this !== lease)
                failure('CONVERSATION_PREPARATION_INVALID');
            return eventAt(index);
        }, preparedResult(index: number): PreparedResultProjection {
            if (this !== lease)
                failure('CONVERSATION_PREPARATION_INVALID');
            assert();
            const selected = pruned.get(index);
            if (selected)
                return selected;
            const event = eventAt(index);
            if (event.type !== 'tool/result')
                failure('CONVERSATION_PAYLOAD_NOT_PREPARED');
            return { kind: 'complete-result', event: event as Extract<SessionEventView, {
                    type: 'tool/result';
                }> };
        }, async settle() {
            if (this !== lease)
                failure('CONVERSATION_PREPARATION_INVALID');
            active = false;
            full.clear();
            pruned.clear();
            substitutes.clear();
            leases.delete(lease);
        }
    });
    preparations.set(lease, { candidate: owned, current: assert, archive, pruned, substitutes, coordinates: payload.coordinates, state: payload.state });
    leases.add(lease);
    return lease;
}
export function readRestoredRecovery(lease: PreparedConversationArchive, ownerSessionId: string, binding?: {
    providerId?: string;
    modelId: string;
    protocol: string;
}) {
    const prepared = preparations.get(lease);
    if (!prepared)
        failure('CONVERSATION_PREPARATION_INVALID');
    prepared.current();
    return prepared.candidate.context.recovery(ownerSessionId, binding);
}
export function readRestoredBudget(lease: PreparedConversationArchive, ownerSessionId: string) {
    const prepared = preparations.get(lease);
    if (!prepared)
        failure('CONVERSATION_PREPARATION_INVALID');
    prepared.current();
    return prepared.candidate.context.budget(ownerSessionId);
}

export function readRestoredGenerations(lease:PreparedConversationArchive){const prepared=preparations.get(lease);if(!prepared)failure('CONVERSATION_PREPARATION_INVALID');prepared.current();return readConversationGenerations(prepared.candidate.index)}

/** Immediate prospective projection on the SAME original validation index. */
export async function previewRestoredConversationCandidate(lease:PreparedConversationArchive,rewrites:readonly ConversationRewriteDraft[],options:{candidateId:string;ownerSessionId:string;capturePayload?:ConversationPayloadCapture;assertCurrent?:()=>void}):Promise<ConversationCandidate&{assertCurrent():void}>{
 const prepared=preparations.get(lease);if(!prepared)failure('CONVERSATION_PREPARATION_INVALID')
 const extra=options.assertCurrent,ownerSessionId=options.ownerSessionId,candidateId=options.candidateId,capturePayload=options.capturePayload;
 const current=()=>{prepared.current();extra?.();prepared.current()};current()
 const owned=prepared.candidate;if(ownerSessionId!==owned.sessionId)failure('CONVERSATION_RESTORATION_OWNER_MISMATCH')
 const id=candidateId;if(typeof id!=='string'||!id.length||id.length>256)throw new TypeError('Invalid conversation candidate id')
 let stage:Awaited<ReturnType<typeof prepareConversationAppend>>|undefined,primary:unknown,failed=false,result:ConversationCandidate|undefined
 try{
 const count=owned.index.eventCount,suffix=captureRewrites(rewrites,count);current()
 const read=async(index:number)=>{current();const value=index>=count?suffix[index-count]!:await owned.source.readEvent(index);current();return value}
 stage=await prepareConversationAppend(owned.index,suffix,read,current);current()
 const payload=await hydratePreparation(owned,current,{history:stage.history(),coordinates:extendConversationSourceCoordinates(prepared.coordinates,suffix),prune:extendPruneDependencyView(owned.prune.read(),suffix),read});current()
 const archive={length:count+suffix.length,get(index:number){current();const event=index>=count?suffix[index-count]:payload.full.get(index);if(!event)failure('CONVERSATION_PAYLOAD_NOT_PREPARED');return event}}
 const projection=renderConversationItems(archive,stage.history(),{ownerSessionId,capturePayload,header:owned.source.header,candidate:{id,baseCount:count},sourceCoordinates:payload.coordinates,pruneSubstitutes:payload.substitutes,prunedResults:payload.pruned});current()
 result=Object.freeze({kind:'candidate',candidateId:id,sourceEventCount:count,projectedEventCount:archive.length,projection})
 }catch(error){failed=true;primary=error}
 const cleanup:unknown[]=[];try{stage?.discard()}catch(error){cleanup.push(error)}try{await owned.source.settle()}catch(error){cleanup.push(error)}
 if(cleanup.length)throw new AggregateError([...(failed?[primary]:[]),...cleanup],'Conversation preview cleanup failed');if(failed)throw primary;current();return Object.freeze({...result!,assertCurrent:current})
}
