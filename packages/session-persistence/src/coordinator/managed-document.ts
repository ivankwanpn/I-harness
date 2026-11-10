import {taskParentMetadataProjection} from './task-parent-metadata.ts'
import { notIssuedFailure } from './not-issued.ts'
import { resolveUnissuedConflict } from './unissued-conflict.ts'
import {types} from 'node:util'
import {associateArtifactCurrentnessReader,createArtifactCurrentGuard,isArtifactCurrentGuard,withImmediateArtifactCurrentChecks} from './artifact-path-association.ts'
import type { createColdExecutionWrites } from './cold-execution-writes.ts';
import { canJoinOriginalNativePrewrite } from '../native-fact-writer-internal.ts';
import { createDeliveryControl,createOwnerDeliveryControl } from '../../../core-session/src/managed/delivery-control.ts';
import {assertOriginalManagedTaskHistory,isManagedExecutionDomain,type ManagedExecutionDomain,type restoreManagedExecutionState,type OriginalExecutionCaptureHooks} from '@i-harness/core-session/internal/execution';
import { createBootstrapManagedSessionState } from '@i-harness/core-session/internal/bootstrap';
import type { BootstrapDocumentControl } from './bootstrap-types.ts';
import { randomUUID } from 'node:crypto';
import { CURRENT_FORMAT_VERSION, captureFactGroup, createManagedSessionState, encodeFactBatch, FactRecoveryRequiredError, resolveFactGroup, stringifyJsonData, bindFactSettlementSource, type CapturedFactGroup, type FactGroupDraft, type FactOutcome, type FactReceipt, type JournalPrefix, type Session, type SessionView } from '@i-harness/core-session';
import type { BackendFactOutcome, ManagedDocument, HeldFactOwner } from './fact-types.ts';
import type { Ownership } from './ownership.ts';
import type { CoordinatorOptions, PersistenceBackend } from './types.ts';
import { createFactCapacity } from './fact-capacity.ts';
import { createFactPorts } from './fact-ports.ts';
import { createSettlementSource } from './settlement-source.ts';
import { heldFactOwner, issuingFactOwner } from './fact-owner.ts';
import { preflightBatchShape } from '../format/validation.ts';
import { createReceivedInputSource } from './received-input-source.ts';
import { cancellationRetirementFor,cancellationRetirementForIndex } from './received-input-cancellation.ts';
import { ownBackendOutcome, sameBatchKey } from './fact-outcome.ts';
import { createActionCaptures } from './action-captures.ts';
import type { createProcessReadLatches } from './process-read-latches.ts';
type TaskMetadataUpdate={before(meta:unknown):void;after(meta:unknown):void;finish(success:boolean):void}
type RequiredTaskParentReadiness={assertOriginal():void;assertCurrent():void;assertTask14Ready():void;joinIssuedWriter():Promise<void>;acquireWriter():Promise<Readonly<{resume():Promise<void>;park():void;release():void}>>}

type TaskParentReadiness=Readonly<{view:SessionView;assertCurrent():void;assertOriginal():void;assertTask14Ready():void}>
type Ticket = {
    release(): void;
};
type Action = {
    stopped: boolean;
    signal?: AbortSignal;
    cancel?: AbortController;
};
type Authorization = {
    action: Action;
    required: boolean;
    source?: object;
    assertSource?: () => void;
};
type Entry = {
    settleProcess?: (outcome: FactOutcome) => void;
    group?: CapturedFactGroup;
    bootstrap?: { phase: 'seed' | 'completion'; events: readonly import('@i-harness/core-session').SessionEvent[]; batchId: string };
    ticket: Ticket;
    resolve(outcome: FactOutcome): void;
    bytes: number;
    seqs?: readonly number[];
    authorization: Authorization;
};
type Pending = {
    active?: boolean;
    staged?:Awaited<ReturnType<Awaited<ReturnType<typeof restoreManagedExecutionState>>['prepareWrite']>>;
    processReconciliation?: { token: ReturnType<ReturnType<typeof createProcessReadLatches>['beginMutation']> | undefined; users: number };
    batch: ReturnType<typeof encodeFactBatch>;
    prefix: JournalPrefix;
    entries: Entry[];
    events: readonly import('@i-harness/core-session').SessionEventView[];
    install(receipt: FactReceipt): void;
    receipt?: FactReceipt;
    issued: boolean;
    issuer?: import('./fact-types.ts').IssuingFactOwner;
    settlement: ReturnType<typeof Promise.withResolvers<void>>;
    settlementSettled: boolean;
    cleanupReported?: boolean;
    installationFailure?: { error: unknown };
};
export interface ManagedReadyObservation {
    readonly document: ManagedDocument; readonly held: HeldFactOwner;
    readonly view: SessionView; readonly events: SessionView['events']; readonly eventCount: number;
    readonly prefix: Readonly<JournalPrefix>;
    assertCurrent(): void;
}
export type SelectedSourceRead = ManagedReadyObservation & { readonly header: SessionView['header']; unsubscribe():void };
export type ManagedTaskSourceRead = Readonly<{kind:'managed-task-source';sessionId:string;document:ManagedDocument;held:HeldFactOwner;header:SessionView['header'];artifacts:ReturnType<typeof assertOriginalManagedTaskHistory>;prefix:Readonly<JournalPrefix>;assertCurrent():void;unsubscribe():void}>;
const managedTaskSourceReads=new WeakSet<object>();
export function assertOriginalManagedTaskSourceRead(witness:ManagedTaskSourceRead):void {if(!managedTaskSourceReads.has(witness))throw new FactRecoveryRequiredError();witness.assertCurrent()}
type ProcessUpdate = { kind: 'unchanged'; highWater: number } | { kind: 'suffix'; from: number; to: number; events: SessionView['events'] };
type ManagedProcessCapture = { readonly initial: SessionView; take(): ProcessUpdate; assertHealthy(): void; assertDrained(): void; markVerified(): void; close(): void };
const executionStatuses = new WeakMap<ManagedDocument, () => 'available' | 'unavailable' | 'retired'>();
type ExecutionState=Awaited<ReturnType<typeof restoreManagedExecutionState>>;
const privateExecutionOwners=new WeakMap<ManagedDocument,{core:ExecutionState;held:HeldFactOwner;ownership:Ownership;assertCurrent():void;retainTask(domain:ManagedExecutionDomain,history:object,onRevoke:()=>void):ManagedTaskSourceRead;materialize(events:readonly import('@i-harness/core-session').SessionEventView[]):ManagedDocument&{assertObservable():void};invalidateMetadata(revision:object):void;beginTaskMetadata():TaskMetadataUpdate;captureTaskParent():Omit<TaskParentReadiness,'view'>;captureRequiredParent(source:import('@i-harness/core-session').SettlementFacts):RequiredTaskParentReadiness;parent():{assertOriginal():void;assertCurrent():void;assertTask14Ready():void}}>();
export function originalManagedExecution(document:ManagedDocument,ownership:Ownership){const original=privateExecutionOwners.get(document);if(!original||original.ownership!==ownership)throw TypeError('Original private execution owner required');return original}
export function managedExecutionStatus(document: ManagedDocument): 'available' | 'unavailable' | 'retired' {
    return executionStatuses.get(document)?.() ?? 'unavailable';
}
const readyOwners = new WeakMap<object, { ownership: Ownership; invalidateMetadata(revision:object):void; captureTaskParent():TaskParentReadiness;beginTaskMetadata():TaskMetadataUpdate; capture(): ManagedReadyObservation; retainSelected(onRevoke:()=>void):SelectedSourceRead; captureRequiredParent(source: import('@i-harness/core-session').SettlementFacts): Readonly<{view:SessionView;assertCurrent():void;assertOriginal():void;assertTask14Ready():void;joinIssuedWriter():Promise<void>;acquireWriter():Promise<Readonly<{resume():Promise<void>;park():void;release():void}>>}>; captureParent(): Readonly<{ view: SessionView; assertCurrent(): void; assertOriginal():void; assertTask14Ready(): void }>; captureProcess(documentKeys: readonly string[], checkEntry: () => void): ManagedProcessCapture }>();
type RestoredStage = (events: readonly import('@i-harness/core-session').SessionEventView[], readCurrentEvent:(index:number)=>import('@i-harness/core-session').SessionEventView|undefined)=>{install(batch:ReturnType<typeof encodeFactBatch>,receipt:FactReceipt):void}
const restoredStages = new WeakMap<ManagedDocument, RestoredStage>()
/** Only the actual managed constructor/ownership association may bind its read fold. */
export function bindManagedRestoredStage(document:ManagedDocument,ownership:Ownership,stage:RestoredStage){
  const original=readyOwners.get(document);if(!original||original.ownership!==ownership||restoredStages.has(document))throw new FactRecoveryRequiredError();restoredStages.set(document,stage)
}
export function captureManagedProcessRead(document: ManagedDocument, ownership: Ownership, documentKeys: readonly string[], checkEntry: () => void): ManagedProcessCapture {
    const original = readyOwners.get(document);
    if (!original || original.ownership !== ownership) throw new FactRecoveryRequiredError();
    return original.captureProcess(documentKeys, checkEntry);
}
export function captureManagedParentReadiness(document: ManagedDocument, ownership: Ownership) {
    const execution=privateExecutionOwners.get(document);if(execution){if(execution.ownership!==ownership)throw new FactRecoveryRequiredError();return execution.parent()}
    const original = readyOwners.get(document);
    if (!original || original.ownership !== ownership) throw new FactRecoveryRequiredError();
    return original.captureParent();
}
export function captureManagedRequiredParent(document:ManagedDocument,ownership:Ownership,source:import('@i-harness/core-session').SettlementFacts) {
 const execution=privateExecutionOwners.get(document);if(execution){if(execution.ownership!==ownership)throw new FactRecoveryRequiredError();return execution.captureRequiredParent(source)}
 const original=readyOwners.get(document);if(!original||original.ownership!==ownership)throw new FactRecoveryRequiredError();return original.captureRequiredParent(source)
}
/** Private original-factory observation. No caller-shaped document/owner can issue it. */
export function captureManagedReadyObservation(document: ManagedDocument, ownership: Ownership): ManagedReadyObservation {
    const original = readyOwners.get(document);
    if (!original || original.ownership !== ownership) throw new FactRecoveryRequiredError();
    return original.capture();
}
export function retainSelectedSourceRead(document:ManagedDocument,ownership:Ownership,onRevoke:()=>void):SelectedSourceRead {
    const original=readyOwners.get(document);
    if(!original||original.ownership!==ownership||typeof onRevoke!=='function')throw new FactRecoveryRequiredError();
    return original.retainSelected(onRevoke);
}
/** Resolve the captured caller owner through this coordinator's original factory. */
export function retainTaskSourceRead(owner:object,view:SessionView,ownership:Ownership,onRevoke:()=>void):SelectedSourceRead {
 const original=readyOwners.get(owner)
 if(!original||original.ownership!==ownership)throw new FactRecoveryRequiredError()
 const witness=original.retainSelected(onRevoke)
 try { if(witness.document!==owner||witness.view!==view)throw new FactRecoveryRequiredError();witness.assertCurrent();return witness }
 catch(error){witness.unsubscribe();throw error}
}
/** Only a verified retained cut on this coordinator's original private owner can issue native Task observation authority. */
export function retainManagedTaskSourceRead(domain:ManagedExecutionDomain,history:object,ownership:Ownership,onRevoke:()=>void):ManagedTaskSourceRead {
 if(!isManagedExecutionDomain(domain)||typeof onRevoke!=='function')throw new FactRecoveryRequiredError()
 const owner=domain.owner, original=privateExecutionOwners.get(owner as ManagedDocument)
 if(!original||original.ownership!==ownership||original.core.identity!==domain.identity)throw new FactRecoveryRequiredError()
 assertOriginalManagedTaskHistory(domain,history);return original.retainTask(domain,history,onRevoke)
}
/** Original owner invalidation; no caller can install a replacement witness. */
export function invalidateManagedMetadataWitness(document:ManagedDocument,ownership:Ownership,revision:object) {
 const execution=privateExecutionOwners.get(document);if(execution){if(execution.ownership!==ownership)throw new FactRecoveryRequiredError();execution.invalidateMetadata(revision);return}
 const original=readyOwners.get(document);if(!original||original.ownership!==ownership)throw new FactRecoveryRequiredError()
 original.invalidateMetadata(revision)
}
export function captureManagedTaskParentReadiness(document:ManagedDocument,ownership:Ownership){const execution=privateExecutionOwners.get(document);if(execution){if(execution.ownership!==ownership)throw new FactRecoveryRequiredError();return execution.captureTaskParent()}const original=readyOwners.get(document);if(!original||original.ownership!==ownership)throw new FactRecoveryRequiredError();return original.captureTaskParent()}
export function beginManagedTaskMetadataUpdate(document:ManagedDocument,ownership:Ownership){const execution=privateExecutionOwners.get(document);if(execution){if(execution.ownership!==ownership)throw new FactRecoveryRequiredError();return execution.beginTaskMetadata()}const original=readyOwners.get(document);if(!original||original.ownership!==ownership)throw new FactRecoveryRequiredError();return original.beginTaskMetadata()}
/** One owned document, one staged suffix, one private Session/index. All disk
 * mutations join the coordinator's existing session operation lane. */
export function createManagedDocument(id: string, source: Session|undefined, initialPrefix: JournalPrefix, backend: PersistenceBackend, ownership: Ownership, options: CoordinatorOptions | undefined, report: (error: unknown) => void, bootstrap?: { operationId: string; selected?:boolean; bind(control: BootstrapDocumentControl): void }, processLatches?: ReturnType<typeof createProcessReadLatches>, assertTaskOutside: () => void = () => {}, executionChanges?: ReturnType<typeof createColdExecutionWrites>, execution?:{state:Awaited<ReturnType<typeof restoreManagedExecutionState>>;held:HeldFactOwner;assertCurrent():void}): ManagedDocument & {
    assertObservable(): void;
} {
    const core=execution?.state;
    let state = source ? (bootstrap ? createBootstrapManagedSessionState : createManagedSessionState)(source, { sessionId: id }) : undefined, incarnation = execution?.held.owner.incarnation??randomUUID();
    if(!state&&!core)throw TypeError('Original managed state required');
    const originalDelivery=core?createOwnerDeliveryControl(core.delivery,()=>prefix.eventCount):undefined;
    const deliveryControl = originalDelivery?.port??createDeliveryControl(state!.view);
    let publicObservation:{observe:NonNullable<typeof state>['observe']}|undefined=state;
    let bootstrapReady = !bootstrap;
    const formatVersion = source?.formatVersion??core!.formatVersion;
    const owner = execution?.held.owner??Object.freeze({ sessionId: id, incarnation });
    const maxPendingGroups = options?.maxPendingGroups ?? 64, targetBytes = options?.coalesceTargetBytes ?? 262144;
    const capacity = createFactCapacity(maxPendingGroups), queue: Entry[] = [];
    const sourceDrains = new Map<{
        close(): Promise<void>;
    }, { closeOriginal():Promise<void>; action?: Action; finished?: () => boolean; closeRequested: boolean; sourceMethods?:PropertyDescriptorMap;deliveryMethods?:PropertyDescriptorMap }>();
    const inputSources = new Set<ReturnType<typeof createReceivedInputSource>>();
    const actionControllers = new Set<AbortController>();
    const ownedActions = new WeakSet<object>();
    const sourceDispositions = new WeakMap<CapturedFactGroup, FactOutcome>();
    const recoveryHolds = new Set<object>();
    const recoveryWitnesses = new Map<object, ReturnType<NonNullable<typeof processLatches>['beginMutation']>>();
    let faultWitness: ReturnType<NonNullable<typeof processLatches>['beginMutation']> | undefined;
    const fenceFault = () => { faultWitness ??= processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' }); };
    const releaseRecoveryWitness = (source: object) => { const token = recoveryWitnesses.get(source); if (token) { recoveryWitnesses.delete(source); token.end('settled'); } };
    let prefix = initialPrefix, pending: Pending | undefined, closing = false, closed = false, scheduled = false, quarantined = false, sourceFault = false;
    let metadataRevision:object={},metadataStale=false;
    let taskRevision:object={},taskMetadataPending=0,taskMetadataStale=false;
    const selectedListeners=new Set<()=>void>();
    let selectedAdmissions=0;
    const invalidateSelected=()=>{for(const listener of [...selectedListeners]){selectedListeners.delete(listener);try{listener()}catch{}}};
    let pump: Promise<void> = Promise.resolve();
    let requiredWriter: { released: Promise<void>; release(): void } | undefined;
    let settlingFinished: Promise<void> | undefined;
    const held = execution?.held??heldFactOwner(owner, ownership, () => {
        if (closed)
            throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' });
    });
    const actionMembers=new Set<{source:object;finished():boolean}>();
    const releaseFinishedMembers=()=>{if(pending||queue.length)return;for(const record of actionMembers)if(record.finished()){core?.releaseSource(record.source);actionMembers.delete(record)}};
    const executionStatus = (): 'available' | 'unavailable' | 'retired' => {
        if (closing || closed) return 'retired';
        if (!bootstrapReady || quarantined || sourceFault || recoveryHolds.size) return 'unavailable';
        try { held.assertHeld(); return 'available'; } catch { return 'unavailable'; }
    };
    let publishedStatus = executionStatus();
    const publishExecutionStatus = () => { const next = executionStatus(); if (next !== publishedStatus) { publishedStatus = next; executionChanges?.invalidated(id); } if(sourceFault)core?.readinessUnavailable(new FactRecoveryRequiredError());else core?.readinessChanged(quarantined || recoveryHolds.size > 0); };
    type SelectedScope=Readonly<{kind:'selected-lane'}>
    const selectedJournal=(backend as PersistenceBackend & {selectedJournal?:{
      resolveCheckedBirth(id:string,owner:typeof held):Promise<unknown>;bindCheckedBirthLane(id:string,owner:typeof held,birth:unknown):SelectedScope;
      readJournalPrefix(id:string,owner:typeof held,scope:SelectedScope):Promise<JournalPrefix>;
      appendOwnedBatch(id:string,owner:import('./fact-types.ts').IssuingFactOwner,scope:SelectedScope,prefix:JournalPrefix,batch:ReturnType<typeof encodeFactBatch>):Promise<import('./fact-types.ts').BackendFactOutcome>;
      reconcileOwnedBatch(id:string,owner:typeof held,scope:SelectedScope,prefix:JournalPrefix,batch:ReturnType<typeof encodeFactBatch>):Promise<import('./fact-types.ts').BackendFactOutcome>;
    }}).selectedJournal
    let selectedLane:SelectedScope|undefined,selectedIOStarted=false,selectedBindFlight:Promise<void>|undefined
    const settleSelected=async()=>{if(bootstrap?.selected&&selectedIOStarted){if(!backend.settleBootstrapCaptureIO)throw new FactRecoveryRequiredError();await backend.settleBootstrapCaptureIO(id,held);selectedIOStarted=false}}
    const assertAuthorized = (authorization: Authorization) => {
        execution?.assertCurrent();
        held.assertHeld();
        try { authorization.assertSource?.(); }
        catch (error) {
            const code = (error as { code?: string }|null)?.code;
            if (code === 'FACT_PRECONDITION_STALE' || code === 'FACT_CANCELLED' || code === 'FACT_CLOSED') throw error;
            failSource();
            throw new FactRecoveryRequiredError();
        }
        if (quarantined || (sourceFault || recoveryHolds.size > 0) && !authorization.required)
            throw new FactRecoveryRequiredError();
        if (!authorization.required && (closing || authorization.action.stopped || authorization.action.signal?.aborted)) {
            const code = closing ? 'FACT_CLOSED' : 'FACT_CANCELLED';
            throw Object.assign(new Error(code), { code });
        }
    };
    const failQueued = () => {
        fenceFault();
        quarantined = true;
        publishExecutionStatus();
        invalidateSelected();
        capacity.stop('FACT_RECOVERY_REQUIRED');
        for (const entry of queue.splice(0)) {
            entry.ticket.release();
            entry.resolve({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' });
        }
    };
    const failSource = () => {
        assertTaskOutside();
        fenceFault();
        sourceFault = true;
        publishExecutionStatus();
        invalidateSelected();
        capacity.blockOptional('FACT_RECOVERY_REQUIRED');
        for (let index = queue.length - 1; index >= 0; index--) {
            const entry = queue[index]!;
            if (entry.authorization.required)
                continue;
            queue.splice(index, 1);
            entry.ticket.release();
            entry.resolve({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' });
        }
    };
    const finish = (current: Pending, backendOutcome: BackendFactOutcome): {
        results: FactOutcome[];
        observe: boolean;
        cleanupDiagnostic?: boolean;
    } => {
        const outcome = ownBackendOutcome(backendOutcome, current.batch.key, owner, current.issued);
        if (outcome.kind === 'committed') {
            const cleanupDiagnostic = outcome.cleanupDiagnostic === 'file-close-failed' && !current.cleanupReported;
            if (cleanupDiagnostic) current.cleanupReported = true;
            const receipt = current.receipt??outcome.receipt;
            current.receipt ??= receipt;
            try {
                current.install(receipt);
                current.installationFailure = undefined;
            }
            catch (error) {
                current.installationFailure = { error };
                failQueued();
                return { results: current.entries.map(() => ({ kind: 'recovery-required', code: 'FACT_INSTALL_FAILED', receipt })), observe: false, cleanupDiagnostic };
            }
            prefix = { eventCount: prefix.eventCount + current.batch.key.count, bodyBytes: prefix.bodyBytes + current.batch.bytes.length, prefixDigest: receipt.prefixDigest };
            pending = undefined;
            const results = current.entries.map(entry => {
                const seqs = entry.seqs!;
                entry.ticket.release();
                const outcome = Object.freeze({ kind: 'committed' as const, receipt, seqs });
                entry.settleProcess?.(outcome);
                if (entry.group) sourceDispositions.set(entry.group, outcome);
                if(entry.group)core?.acknowledge(entry.group,outcome);
                return outcome;
            });
            return { results, observe: true, cleanupDiagnostic };
        }
        if (outcome.kind === 'unknown' || outcome.kind === 'conflict')
            failQueued();
        else {
            if(current.staged){if(outcome.kind==='absent')current.staged.settleAbsent({kind:'absent',key:outcome.key});else if(!current.issued)current.staged.discardUnissued()}
            pending = undefined;
            for (const entry of current.entries) {
                entry.ticket.release();
                if (entry.group) sourceDispositions.set(entry.group, outcome);
                entry.settleProcess?.(outcome);
            }
        }
        return { results: current.entries.map(() => outcome), observe: false };
    };
    const observeInstalled = (events: Pending['events']) => {
        publicObservation?.observe(events as readonly import('@i-harness/core-session').SessionEvent[], report);
        if (events.some(event => ['code/cell', 'code/output', 'code/call', 'code/dispatch', 'code/result'].includes(event.type))) executionChanges?.committed(id);
    };
    const reportCleanup = () => {
        try {
            void Promise.resolve(report(new Error('Managed journal file close failed after sync'))).catch(() => {});
        } catch { /* Diagnostics cannot change the known committed disposition. */ }
    };
    const run = async () => {
        while (queue.length && !pending) {
            if (requiredWriter) { await requiredWriter.released; continue; }
            let current: Pending | undefined, completed: ReturnType<typeof finish> | undefined;
            await ownership.withSessionOperation(id, async () => {
                if (requiredWriter) return;
                const entries: Entry[] = [], events: ReturnType<typeof resolveFactGroup> = [];
                let bytes = 0;
                while (queue.length && (!entries.length || bytes + queue[0]!.bytes <= targetBytes
                    && queue[0]!.authorization.action === entries[0]!.authorization.action
                    && queue[0]!.authorization.source === entries[0]!.authorization.source
                    && queue[0]!.authorization.required === entries[0]!.authorization.required
                    && !queue[0]!.bootstrap && !entries[0]!.bootstrap)) {
                    const entry = queue.shift()!;
                    try {
                        assertAuthorized(entry.authorization);
                        // Check the original delivery fence before staging a Code
                        // handoff. A closed generation otherwise looks like an
                        // invalid transition before the stale fence is consulted.
                        if (entry.group?.kind === 'delivery' && entry.group.event.type === 'agent/delivery-handoff' && (entry.group.event.kind === 'code' || entry.group.event.kind === 'workflow'))
                            deliveryControl.assert([entry.group.event]);
                        const suffix = core ? [] : entry.bootstrap ? [...entry.bootstrap.events] : resolveFactGroup(entry.group!, state!.view, prefix.eventCount + events.length);
                        if (entry.bootstrap && suffix.some((event, position) => event.seq !== prefix.eventCount + events.length + position)) throw new TypeError('Invalid bootstrap phase sequence');
                        entry.seqs = Object.freeze(suffix.map(event => event.seq!));
                        entries.push(entry);
                        events.push(...suffix);
                        bytes += entry.bytes;
                    }
                    catch (error) {
                        entry.ticket.release();
                        entry.resolve({ kind: 'not-issued', code: (error as {
                                code?: 'FACT_CLOSED' | 'FACT_CANCELLED' | 'FACT_RECOVERY_REQUIRED' | 'FACT_PRECONDITION_STALE';
                            }|null)?.code ?? 'FACT_INVALID_GROUP' });
                    }
                }
                if (!entries.length)
                    return;
                let executionStage:Pending['staged'];
                try {
                    executionStage=core?await core.prepareWrite(entries.map(entry=>entry.group!),true):undefined;
                    if(executionStage)for(const rejection of executionStage.rejected){for(let index=entries.length-1;index>=0;index--)if(entries[index]!.group===rejection.group){const entry=entries.splice(index,1)[0]!;entry.ticket.release();entry.resolve({kind:'not-issued',code:'FACT_INVALID_GROUP'})}}
                    if(!entries.length){executionStage?.discardUnissued();return}
                    for(const entry of entries)assertAuthorized(entry.authorization);
                    const staged = executionStage??state!.stage(events);
                    if(executionStage)for(const [index,entry]of entries.entries())entry.seqs=Object.freeze(executionStage.members[index]!.events.map(event=>event.seq!));
                    deliveryControl.assert(staged.events);
                    preflightBatchShape(formatVersion, staged.events as readonly import('@i-harness/core-session').SessionEvent[]);
                    const restored = restoredStages.get(document)?.(staged.events, position => state!.view.events[position]);
                    const batch = encodeFactBatch(entries[0]!.bootstrap?.batchId ?? randomUUID(), prefix.prefixDigest, staged.events);
                    const operation:Pending = { batch, prefix, entries, events: staged.events,staged:executionStage, install(receipt) { if(executionStage)executionStage.install(batch,receipt);else (staged as ReturnType<NonNullable<typeof state>['stage']>).install(); restored?.install(batch,receipt) }, issued: false, settlement: Promise.withResolvers<void>(), settlementSettled: false };
                    pending = current = operation;
                    operation.active = true;
                    const issuer = issuingFactOwner(held, () => {
                        if (requiredWriter) throw new FactRecoveryRequiredError();
                        if (operation.issued)
                            throw new FactRecoveryRequiredError();
                        for (const entry of entries)
                            assertAuthorized(entry.authorization);
                        deliveryControl.assert(operation.events);
                        operation.staged?.beforeIssue(operation.batch);
                        operation.issued = true;
                    });
                    current.issuer = issuer;
                    if (bootstrap?.selected && selectedIOStarted) await settleSelected();
                    if (requiredWriter) throw new FactRecoveryRequiredError();
                    if(bootstrap?.selected)selectedIOStarted=true;
                    const outcome = bootstrap?.selected ? await selectedJournal!.appendOwnedBatch(id,issuer,selectedLane!,prefix,batch) : await backend.appendOwnedBatch!(id,issuer,prefix,batch);
                    completed = finish(current, outcome);
                }
                catch (error) {
                    if (current?.issued) {
                        // The append may have committed before the failure. Ask the
                        // backend to reconcile that exact batch before declaring an
                        // unknown outcome: an unreconciled unknown leaves the
                        // execution's pending write set forever and wedges every
                        // later write in the process.
                        let reconciled: BackendFactOutcome | undefined
                        try {
                            reconciled = bootstrap?.selected
                                ? await selectedJournal!.reconcileOwnedBatch(id, held, selectedLane!, prefix, current.batch)
                                : await backend.reconcileOwnedBatch!(id, held, prefix, current.batch)
                        } catch { reconciled = undefined }
                        completed = finish(current, reconciled ?? { kind: 'unknown', key: current.batch.key });
                    }
                    else {
                        (current?.staged??executionStage)?.discardUnissued();
                        pending = undefined;
                        for (const entry of entries) {
                            entry.ticket.release();
                            const code = (error as { code?: string }|null)?.code;
                            entry.resolve({ kind: 'not-issued', code: code === 'FACT_PRECONDITION_STALE' || code === 'FACT_CANCELLED' || code === 'FACT_CLOSED' || code === 'FACT_RECOVERY_REQUIRED' ? code : 'FACT_INVALID_GROUP' });
                        }
                    }
                }
            });
            // Join only this original batch, after its disposition and outside its lane.
            if (current) {
                current.active = false;
                current.settlementSettled = true;
                current.settlement.resolve();
            }
            // The operation lane is released before any observer may append again.
            if (current && completed) {
                for (const [index, entry] of current.entries.entries())
                    entry.resolve(completed.results[index]!);
                if (completed.observe)
                    observeInstalled(current.events);
                if (completed.cleanupDiagnostic) reportCleanup();
            }
        }
    };
    const schedule = () => {
        if (scheduled)
            return;
        scheduled = true;
        pump = Promise.resolve().then(run).catch(report).finally(() => {
            scheduled = false;
            releaseFinishedMembers();
            if (queue.length && !pending)
                schedule();
        });
    };
    async function admitCore(draft: FactGroupDraft | CapturedFactGroup, authorization: Authorization, captured = false, settle?: (outcome: FactOutcome) => void): Promise<FactOutcome> {
        if (!bootstrapReady) return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' };
        if (closed || closing && !authorization.required)
            return { kind: 'not-issued', code: 'FACT_CLOSED' };
        if (!authorization.required && (authorization.action.stopped || authorization.action.signal?.aborted))
            return { kind: 'not-issued', code: 'FACT_CANCELLED' };
        if (quarantined || (sourceFault || recoveryHolds.size > 0) && !authorization.required)
            return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' };
        selectedAdmissions++;
        try {
        invalidateSelected();
        const ticket = await capacity.acquire(authorization.required ? undefined : authorization.action.signal, authorization.required);
        if (typeof ticket === 'string')
            return { kind: 'not-issued', code: ticket };
        if (closed || closing && !authorization.required || quarantined || (sourceFault || recoveryHolds.size > 0) && !authorization.required) {
            ticket.release();
            return { kind: 'not-issued', code: quarantined || sourceFault || recoveryHolds.size ? 'FACT_RECOVERY_REQUIRED' : 'FACT_CLOSED' };
        }
        const capture = captured ? { kind: 'captured' as const, group: draft as CapturedFactGroup } : captureFactGroup(draft as FactGroupDraft);
        if (capture.kind !== 'captured') {
            ticket.release();
            if (authorization.required)
                failSource();
            return capture;
        }
        const bytes = Buffer.byteLength(stringifyJsonData(capture.group)!);
        return new Promise(resolve => {
            queue.push({ group: capture.group, bytes, ticket, settleProcess: settle, resolve(outcome) { settle?.(outcome); resolve(outcome); }, authorization });
            schedule();
        });
        } finally { selectedAdmissions--; }
    }
    async function admit(draft: FactGroupDraft | CapturedFactGroup, authorization: Authorization, captured = false): Promise<FactOutcome> {
        assertTaskOutside();
        const token = processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'managed-append', managedOwner: owner });
        let settled = false;
        const settle = (outcome: FactOutcome) => {
            if (settled) return;
            // Unknown/recovery-required remains owned by the original pending
            // frame. No unrelated retry may retire its witness.
            if (outcome.kind === 'committed' || outcome.kind === 'absent' || outcome.kind === 'not-issued') { settled = true; token?.end('settled'); }
        };
        try {
            const outcome = await admitCore(draft, authorization, captured, settle);
            settle(outcome);
            return outcome;
        } catch (error) { if (!settled) token?.end(notIssuedFailure(error) ? 'settled' : 'unknown'); throw error; }
    }
    const rootAuthorization: Authorization = { action: { stopped: false }, required: false };
    const ports = createFactPorts(draft => admit(draft, rootAuthorization));
    function revokeOriginalWork() {
        assertTaskOutside();
        const token = processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' });
        let outcome: 'settled' | 'unknown' = 'unknown';
        try {
            closing = true;
            publishExecutionStatus();
            invalidateSelected();
            deliveryControl.retire();core?.stopNewWork();
            capacity.revokeNewWork();
            for (const source of inputSources) source.revoke();
            for (const controller of actionControllers) controller.abort();
            outcome = 'settled';
        } finally { token?.end(outcome); }
    }
    async function drainOriginalSourceOwners() {
        assertTaskOutside();held.assertHeld();
        if(closed)return;
        const drains = await Promise.allSettled([...sourceDrains.values()].map(entry => entry.closeOriginal()));
        await pump;
        held.assertHeld();
        if (pending || quarantined || sourceFault || recoveryHolds.size || drains.some(result => result.status === 'rejected'))
            throw Object.assign(new FactRecoveryRequiredError(),{cause:new AggregateError(drains.flatMap(result=>result.status==='rejected'?[result.reason]:[]),'Original document sources require cleanup')});
    }
    const document: ManagedDocument & {
        assertObservable(): void;
    } = {
        importSeed: events => admit({ kind: 'seed-import', events }, rootAuthorization),
        assertReady() {
            if (!bootstrapReady) throw new FactRecoveryRequiredError();
            assertAuthorized(rootAuthorization);
        },
        revokeNewWork() {
            revokeOriginalWork();
        },
        ...ports,
        registerReceivedInputSource(drain) {
            if (!bootstrapReady) throw new FactRecoveryRequiredError();
            assertAuthorized(rootAuthorization);
            const required: Authorization = { action: { stopped: false }, required: true, assertSource: () => source.assertHeld() };
            let inputHooks:OriginalExecutionCaptureHooks|undefined;
            const inputMembers:OriginalExecutionCaptureHooks={capture:(group,commands)=>inputHooks!.capture(group,commands),forward:(original,commands)=>inputHooks!.forward(original,commands)};
            const source = createReceivedInputSource(drain, {
                ...(core?{captureMembers:inputMembers}:{}),
                owner, deliveryControl, document, view:state?.view,
                guarded(checkCurrent) {
                    const guarded = {...required,source:{},assertSource() {source.assertHeld();if(!checkCurrent())throw Object.assign(new Error("FACT_PRECONDITION_STALE"),{code:"FACT_PRECONDITION_STALE"})}};
                    return {...(core?{captureMembers:inputMembers}:{}),assertHeld:held.assertHeld,admit:group=>{sourceDispositions.delete(group);return admit(group,guarded,true)},reconcile:key=>document.reconcile(key),status:group=>sourceDispositions.get(group),quarantineCapture:failSource};
                },
                cancellationRetirement: core?cancellationRetirementForIndex(held.assertHeld,core.intake,core.header?.seedLength??0):cancellationRetirementFor(state!.view, document),
                assertHeld: held.assertHeld, admit: group => {
                    sourceDispositions.delete(group);
                    return admit(group, required, true);
                },
                reconcile: key => document.reconcile(key), status: group => sourceDispositions.get(group), quarantineCapture: failSource,
            }, () => {
                sourceDrains.delete(source);
                inputSources.delete(source);
                core?.releaseSource(source);
            });
            if(core)inputHooks=core.captureHooks(source,held.assertHeld);
            required.source = source;
            sourceDrains.set(source, { closeOriginal:source.close.bind(source), closeRequested: false });
            inputSources.add(source);
            return source;
        },
        beginAction(signal) {
            if (!bootstrapReady) throw new FactRecoveryRequiredError();
            const cancel = new AbortController();
            let finished = false;
            let actionHooks:OriginalExecutionCaptureHooks|undefined;
            const actionCaptureMembers:OriginalExecutionCaptureHooks={capture:(group,commands)=>actionHooks!.capture(group,commands),forward:(original,commands)=>actionHooks!.forward(original,commands)};
            const action: Action = { signal: signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal, stopped: false, cancel }, authorization = { action, required: false };
            assertAuthorized(authorization);
            actionControllers.add(cancel);
            const capability: import('@i-harness/core-session').ManagedAction<FactOutcome> = {
                signal: action.signal!,
                facts: createFactPorts(draft => admit(draft, authorization),async event=>{
                    if(closing||closed||metadataStale||quarantined||sourceFault||recoveryHolds.size||action.stopped||action.signal?.aborted)return admit({kind:'tool',event},authorization);
                    return capability.captureToolCall!(event).admit();
                }),
                ...createActionCaptures({
                    ...(core?{captureMembers:actionCaptureMembers}:{}),
                    assertHeld: held.assertHeld,
                    admit: group => {
                        sourceDispositions.delete(group);
                        return admit(group, authorization, true);
                    },
                    reconcile: key => document.reconcile(key), status: group => sourceDispositions.get(group), quarantineCapture: failSource,
                }, checkCurrent => {
                    const guarded: Authorization = { action, required: false, source: {}, assertSource() {
                        if (!checkCurrent()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' });
                    } };
                    return { ...(core?{captureMembers:actionCaptureMembers}:{}),assertHeld: held.assertHeld, admit: group => {
                        sourceDispositions.delete(group);
                        return admit(group, guarded, true);
                    }, reconcile: key => document.reconcile(key), status: group => sourceDispositions.get(group), quarantineCapture: failSource };
                }),
                assertOpen: originalGuardDependencies ? createArtifactCurrentGuard(() => {assertGuardMethods();assertAuthorized(authorization)}) : () => assertAuthorized(authorization), stop() {
                    action.stopped = true;
                    cancel.abort();
                },
                finish() {
                    finished = true;
                    action.stopped = true;
                    actionControllers.delete(cancel);
                    releaseFinishedMembers();
                },
                registerSettlementSource(drain, reconcilePending, checkpointOwner) {
                    assertAuthorized(authorization);
                    const required: Authorization = { action, required: true, assertSource: () => source.assertHeld() };
                    const source = createSettlementSource(drain, {
                        ...(core?{captureMembers:(source:import('@i-harness/core-session').SettlementFacts)=>core.captureHooks(source,held.assertHeld)}:{}),
                        assertHeld: held.assertHeld,
                        admitCaptured: group => {
                            sourceDispositions.delete(group);
                            return admit(group, required, true);
                        },
                        reconcile: key => document.reconcile(key), status: group => sourceDispositions.get(group),
                        quarantineCapture: failSource,
                        onCloseRequested() {
                            assertTaskOutside();
                            const entry = sourceDrains.get(source);
                            if (entry) entry.closeRequested = true;
                        },
                        holdRecovery() {
                            assertTaskOutside();
                            if (!sourceDrains.has(source)) throw new FactRecoveryRequiredError();
                            if (!recoveryWitnesses.has(source)) { const token = processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' }); if (token) recoveryWitnesses.set(source, token); }
                            recoveryHolds.add(source); publishExecutionStatus(); invalidateSelected(); capacity.holdOptional(source);
                            for (let index = queue.length - 1; index >= 0; index--) {
                                const entry = queue[index]!; if (entry.authorization.required) continue;
                                queue.splice(index, 1); entry.ticket.release(); entry.resolve({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' });
                            }
                        },
                        releaseRecovery() { assertTaskOutside(); recoveryHolds.delete(source); capacity.releaseOptional(source); releaseRecoveryWitness(source); publishExecutionStatus() },
                    }, () => { sourceDrains.delete(source);core?.releaseSource(source); recoveryHolds.delete(source); capacity.releaseOptional(source); releaseRecoveryWitness(source); publishExecutionStatus() }, reconcilePending, checkpointOwner);
                    required.source = source;
                    core?.associateActionSource(capability,source);
                    const publicView=Object.getOwnPropertyDescriptor(document,'view')?.value as SessionView|undefined;
                    if(publicView)bindFactSettlementSource(publicView, document, source, id);
                    sourceDrains.set(source, { closeOriginal:source.close.bind(source), action, finished: () => finished, closeRequested: false, sourceMethods:Object.getOwnPropertyDescriptors(source),deliveryMethods:Object.getOwnPropertyDescriptors(source.delivery) });
                    return source;
                },
            };
            const captureCodeCall=capability.captureCodeCall!;
            capability.captureCodeCall=(event,source)=>{assertAuthorized(authorization);if(sourceDrains.get(source)?.action!==action)throw TypeError('Original action source required');const capture=captureCodeCall(event,source);core?.associateActionCaptureSource(capability,source,capture);return capture};
            Object.defineProperty(capability, 'owner', { value: owner, enumerable: true, writable: false, configurable: false });
            for(const name of ['captureToolCall','captureLifecycle','captureMetadata','capturePlanProposal','captureToolDispatch','captureCodeCall'] as const)Object.defineProperty(capability,name,{value:capability[name],enumerable:true,writable:false,configurable:false});
            ownedActions.add(capability);
            if(core){actionHooks=core.captureHooks(capability,held.assertHeld);actionMembers.add({source:capability,finished:()=>finished})}
            return capability;
        },
        ownsAction: action => ownedActions.has(action),
        assertObservable() {
            const uncertainWrite = pending !== undefined && !pending.active;
            if (!bootstrapReady || uncertainWrite || quarantined || sourceFault || recoveryHolds.size > 0)
                throw new FactRecoveryRequiredError();
            execution?.assertCurrent();
            held.assertHeld();
        },
        ...(state?{view:state.view}:{}),
        async reconcile(key) {
            assertTaskOutside();
            const original = pending && sameBatchKey(key, pending.batch.key) ? pending : undefined;
            const witness = original
                ? original.processReconciliation ??= { token: processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' }), users: 0 }
                : { token: processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' }), users: 0 };
            witness.users++;
            let outcome: 'settled' | 'unknown' = 'unknown';
            try {
            let current: Pending | undefined, completed: ReturnType<typeof finish> | undefined;
            await ownership.withSessionOperation(id, async () => {
                current = pending;
                if (!current || !sameBatchKey(key, current.batch.key))
                    return;
                held.assertHeld();
                await settleSelected();
                if(bootstrap?.selected&&!current.receipt)selectedIOStarted=true;
                const reconciled = current.receipt ? { kind: 'committed' as const, receipt: current.receipt }
                    : bootstrap?.selected ? await selectedJournal!.reconcileOwnedBatch(id,held,selectedLane!,current.prefix,current.batch) : await backend.reconcileOwnedBatch!(id, held, current.prefix, current.batch);
                // A conflict/unknown on a batch that was never issued is not an
                // ambiguous durable state: no byte of it reached the journal, so
                // the frame is provably absent. Treating it as such gives the
                // quarantine a real exit instead of requiring a restart. An issued
                // batch keeps the fail-closed path (its fate may be unknown).
                const resolved = resolveUnissuedConflict(reconciled, current.issued);
                completed = finish(current, resolved);
            });
            if (!current || !completed) {
                outcome = 'settled';
                return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' };
            }
            if (completed.observe)
                observeInstalled(current.events);
            if (completed.cleanupDiagnostic) reportCleanup();
            if (!pending) {
                releaseFinishedMembers();
                quarantined = false;
                // Only this original pending owner has resolved quarantine.
                // Existing readers stay invalid; fresh readers may be admitted.
                // A distinct terminal source fault must never be cleared here.
                if (!sourceFault && faultWitness) { faultWitness.end('settled'); faultWitness = undefined; }
                capacity.resume();
            }
            const result = completed.results[0]!;
            outcome = result.kind === 'unknown' || result.kind === 'conflict' || result.kind === 'recovery-required' ? 'unknown' : 'settled';
            return result;
            } finally {
                witness.users--;
                // One original frame owns one reconciliation witness, including
                // concurrent callers and repeated uncertain attempts.
                if (!witness.users && (!original || pending !== original)) witness.token?.end(outcome);
                publishExecutionStatus();
            }
        },
        async drain() {
            await pump;
            await core?.settleDependencies();
            if (pending || quarantined || sourceFault)
                throw new FactRecoveryRequiredError();
        },
        settleFinishedActions() {
            assertTaskOutside();
            held.assertHeld();
            if (closing || closed) throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' });
            if (settlingFinished) return settlingFinished;
            const eligible = [...sourceDrains].filter(([, entry]) => entry.finished?.() === true && entry.closeRequested);
            const originalPending = pending;
            const attempt = (async () => {
                const errors: unknown[] = [];
                if (originalPending) {
                    // Only this captured frame's actual finished owners may
                    // resolve the prerequisite of their original close calls.
                    const qualified = originalPending.entries.every(entry => !entry.bootstrap
                        && eligible.some(([source, metadata]) => metadata.action === entry.authorization.action
                            && (!entry.authorization.required || entry.authorization.source === source)));
                    if (!qualified || pending !== originalPending) throw new FactRecoveryRequiredError();
                    if (closing || closed) throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' });
                    const outcome = await document.reconcile(originalPending.batch.key);
                    if (outcome.kind !== 'committed' && outcome.kind !== 'absent')
                        throw Object.assign(new FactRecoveryRequiredError(), { cause: Object.assign(new Error('Original pending frame requires recovery', originalPending.installationFailure ? { cause: originalPending.installationFailure.error } : undefined), { outcome }) });
                }
                for (const [source] of eligible) {
                    try { await source.close(); } catch (error) { errors.push(error); }
                }
                await pump;
                if (closing || closed) throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED', ...(errors.length ? { cause: new AggregateError(errors, 'Original source settlement failed') } : {}) });
                if (pending || quarantined || sourceFault || recoveryHolds.size || errors.length)
                    throw Object.assign(new FactRecoveryRequiredError(), errors.length ? { cause: new AggregateError(errors, 'Original source settlement failed') } : {});
            })();
            settlingFinished = attempt;
            void attempt.then(() => { if (settlingFinished === attempt) settlingFinished = undefined; }, () => { if (settlingFinished === attempt) settlingFinished = undefined; });
            return attempt;
        },
        async drainOriginalSources() {
            if(this!==document)throw new TypeError('Invalid original document source drain');
            await drainOriginalSourceOwners();
        },
        async close() {
            if (closed)
                return;
            revokeOriginalWork();
            if(core){await pump;await core.settleDependencies()}
            await drainOriginalSourceOwners();
            if(selectedBindFlight)await selectedBindFlight.catch(()=>{});
            await settleSelected();
            if(core){for(const member of actionMembers)core.releaseSource(member.source);actionMembers.clear();await core.close()}
            closed = true;
        },
    } as ManagedDocument & {assertObservable():void};
    bootstrap?.bind({ held, bindSelected() {
        if(!bootstrap.selected||!selectedJournal||!backend.settleBootstrapCaptureIO||closed||closing)return Promise.reject(new FactRecoveryRequiredError());
        if(selectedLane)return Promise.resolve();if(selectedBindFlight)return selectedBindFlight;
        const flight=(async()=>{
            await settleSelected();
            try {
                selectedIOStarted=true;const birth=await selectedJournal.resolveCheckedBirth(id,held);if(!birth||closing||closed)throw new FactRecoveryRequiredError();
                const lane=selectedJournal.bindCheckedBirthLane(id,held,birth),actual=await selectedJournal.readJournalPrefix(id,held,lane);
                if(JSON.stringify(actual)!==JSON.stringify(prefix)||closing||closed)throw new FactRecoveryRequiredError();
                await settleSelected();if(closing||closed)throw new FactRecoveryRequiredError();selectedLane=lane;
            } catch(error) { try{await settleSelected()}catch(cleanup){throw new AggregateError([error,cleanup],'Selected document acquisition cleanup unresolved')}throw error; }
        })();
        selectedBindFlight=flight;void flight.finally(()=>{if(selectedBindFlight===flight)selectedBindFlight=undefined}).catch(()=>{});return flight;
    }, prepareReady(){if(closed||closing||quarantined||bootstrap.selected&&!selectedLane)throw new FactRecoveryRequiredError();return ()=>{bootstrapReady=true;queueMicrotask(publishExecutionStatus)}}, ready() { if(bootstrap.selected&&!selectedLane)throw new FactRecoveryRequiredError();bootstrapReady = true; publishExecutionStatus(); },
        async admit(phase, events, guards) {
            assertTaskOutside();
            const assertSource = () => { if (guards.signal?.aborted) throw Object.assign(new Error('FACT_CANCELLED'), { code: 'FACT_CANCELLED' }); guards.assertCurrent(); };
            const authorization: Authorization = { action: { stopped: false, signal: guards.signal }, required: false, source: bootstrap, assertSource };
            if (bootstrap.selected || pending || quarantined || closed || closing) return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' };
            selectedAdmissions++;
            try {
            invalidateSelected();
            const ticket = await capacity.acquire(guards.signal);
            if (typeof ticket === 'string') return { kind: 'not-issued', code: ticket };
            try { assertAuthorized(authorization); } catch (error) { ticket.release(); return {kind:'not-issued',code:(error as {code?: 'FACT_CANCELLED'}).code ?? 'FACT_PRECONDITION_STALE'}; }
            return new Promise(resolve => { queue.push({ bootstrap: {phase, events, batchId: 'bootstrap:' + bootstrap.operationId + ':' + (phase === 'seed' ? 'seed' : 'complete')}, ticket, resolve, bytes: Buffer.byteLength(stringifyJsonData(events)!), authorization }); schedule(); });
            } finally { selectedAdmissions--; }
        }
    });
    // These are original constructor dependencies, classified without calling
    // accessors. Custom inputs retain immediate checks and their old reads.
    const executionField=core&&execution&&!types.isProxy(execution)?Object.getOwnPropertyDescriptor(execution,'assertCurrent'):undefined
    const heldField=!types.isProxy(held)?Object.getOwnPropertyDescriptor(held,'assertHeld'):undefined
    const executionGuard=executionField&&'value'in executionField&&typeof executionField.value==='function'&&isArtifactCurrentGuard(executionField.value)?executionField.value as ()=>void:undefined
    const heldGuard=heldField&&'value'in heldField&&typeof heldField.value==='function'&&isArtifactCurrentGuard(heldField.value)?heldField.value as ()=>void:undefined
    const originalGuardDependencies=executionGuard&&heldGuard
    const assertGuardMethods=()=>{if(Object.getOwnPropertyDescriptor(execution!,'assertCurrent')?.value!==executionGuard||Object.getOwnPropertyDescriptor(held,'assertHeld')?.value!==heldGuard)throw new FactRecoveryRequiredError()}
    if(originalGuardDependencies){
      const originalReady=document.assertReady
      document.assertReady=createArtifactCurrentGuard(()=>{assertGuardMethods();Reflect.apply(originalReady,document,[])})
      associateArtifactCurrentnessReader(document,'ownsAction')
    }
    const originalPrivateReady=document.assertReady;
    function beginTaskMetadataUpdate() {
        held.assertHeld();if(closed||closing)throw new FactRecoveryRequiredError();
        const revision=taskRevision;taskMetadataPending++;let done=false,before:string|undefined,after:string|undefined,invalid=false;
        return Object.freeze({before(meta:unknown){if(done)throw TypeError('Metadata operation finished');try{before=taskParentMetadataProjection(meta)}catch{invalid=true}},after(meta:unknown){if(done)throw TypeError('Metadata operation finished');try{after=taskParentMetadataProjection(meta)}catch{invalid=true}},finish(success:boolean){if(done)return;done=true;taskMetadataPending--;try{held.assertHeld()}catch{success=false}if(!success||invalid||before===undefined||after===undefined||before!==after||revision!==taskRevision||closed||closing){taskRevision={};taskMetadataStale=true}}});
    }
    function captureRequiredWriterProof<T extends object>(source:import('@i-harness/core-session').SettlementFacts,checkIdentity:()=>void,check:()=>void,extra:T) {
        const joinableWriter=()=>{ownership.assertOutsideSessionOperation(id);checkIdentity();const batch=pending;if(batch){if(batch.settlementSettled||(!batch.issued&&(!batch.issuer||!canJoinOriginalNativePrewrite(backend,id,batch.issuer,batch.batch)))||batch.entries.some(entry=>entry.authorization.source===source)||batch.receipt||batch.installationFailure)throw Object.assign(new FactRecoveryRequiredError(),{cause:{originalBatchIssued:batch.issued,sameRequiredSource:batch.entries.some(entry=>entry.authorization.source===source),receipt:!!batch.receipt,installationFailure:!!batch.installationFailure,eventTypes:batch.events.map(event=>event.type)}});}return batch};
        const joinIssuedWriter=async()=>{const batch=joinableWriter();if(batch)await batch.settlement.promise;check()};
        const result=Object.freeze({...extra,assertOriginal(){if(this!==result)throw new TypeError('Invalid required parent');checkIdentity()},async acquireWriter(){
          if(this!==result)throw new TypeError('Invalid required parent')
          let retired=false,held=false,gate=Promise.withResolvers<void>();gate.resolve()
          const writer={get released(){return gate.promise},release(){if(requiredWriter===writer){requiredWriter=undefined;held=false;gate.resolve()}}}
          const lease=Object.freeze({
            async resume(){if(this!==lease||retired)throw new TypeError('Retired original writer exclusion');if(held&&requiredWriter===writer){check();return}for(;;){const batch=joinableWriter();if(!batch)break;await batch.settlement.promise}check();if(requiredWriter)throw new FactRecoveryRequiredError();gate=Promise.withResolvers<void>();requiredWriter=writer;held=true},
            park(){if(this!==lease)throw new TypeError('Invalid original writer exclusion');writer.release()},
            release(){if(this!==lease)throw new TypeError('Invalid original writer exclusion');retired=true;writer.release()},
          });await lease.resume();return lease
        },async joinIssuedWriter(){if(this!==result)throw new TypeError('Invalid required parent');await joinIssuedWriter()},assertCurrent(){if(this!==result)throw new TypeError('Invalid required parent');check()},assertTask14Ready(){if(this!==result)throw new TypeError('Invalid required parent');check();if(formatVersion!==14)throw new FactRecoveryRequiredError()}});return result;
    }
    function privateTaskParent(source:import('@i-harness/core-session').SettlementFacts):RequiredTaskParentReadiness;
    function privateTaskParent():Omit<TaskParentReadiness,'view'>;
    function privateTaskParent(source?:import('@i-harness/core-session').SettlementFacts) {
      const original=source&&sourceDrains.get(source);
      if(source&&(!original?.action||original.action.stopped||original.closeRequested||!original.sourceMethods||!original.deliveryMethods||formatVersion!==14))throw new FactRecoveryRequiredError();
      const originalReady=originalPrivateReady,revision=taskRevision;
      const rawIdentity=()=>{
        if(closed||taskMetadataPending||taskMetadataStale||revision!==taskRevision||Object.getOwnPropertyDescriptor(document,'assertReady')?.value!==originalReady||quarantined||sourceFault)throw new FactRecoveryRequiredError();
        execution!.assertCurrent();held.assertHeld();
        if(source){if(!sourceDrains.has(source))throw new FactRecoveryRequiredError();for(const [object,fields]of [[source,original!.sourceMethods!],[original!.sourceMethods!.delivery!.value as object,original!.deliveryMethods!]] as const)for(const key of Reflect.ownKeys(fields)){const field=Reflect.get(fields,key) as PropertyDescriptor,now=Object.getOwnPropertyDescriptor(object,key);if(!now||!('value'in now)||now.value!==field.value)throw new FactRecoveryRequiredError()}source.assertHeld()}
      };
      const sourceField=source&&!types.isProxy(source)?Object.getOwnPropertyDescriptor(source,'assertHeld'):undefined
      const sourceGuard=sourceField&&'value'in sourceField&&typeof sourceField.value==='function'&&isArtifactCurrentGuard(sourceField.value)?sourceField.value as ()=>void:undefined
      const originalIdentity=originalGuardDependencies&&(!source||sourceGuard)
      const checkIdentity=originalIdentity?createArtifactCurrentGuard(()=>{assertGuardMethods();if(source&&Object.getOwnPropertyDescriptor(source,'assertHeld')?.value!==sourceGuard)throw new FactRecoveryRequiredError();rawIdentity()}):()=>withImmediateArtifactCurrentChecks(rawIdentity)
      const rawCheck=()=>{checkIdentity();if(source){if(pending)throw new FactRecoveryRequiredError()}else Reflect.apply(originalReady,document,[])}
      const check=originalIdentity&&(source||isArtifactCurrentGuard(originalReady))?createArtifactCurrentGuard(rawCheck):()=>withImmediateArtifactCurrentChecks(rawCheck);check();
      if(source)return captureRequiredWriterProof(source,checkIdentity,check,{});
      const proof=Object.freeze({assertOriginal(){if(this!==proof)throw TypeError('Invalid original Task parent');checkIdentity()},assertCurrent(){if(this!==proof)throw TypeError('Invalid original Task parent');check()},assertTask14Ready(){if(this!==proof)throw TypeError('Invalid original Task parent');check();if(formatVersion!==14)throw new FactRecoveryRequiredError()}});return proof;
    }
    executionStatuses.set(document, executionStatus);
    if(core){
      const originalReady=document.assertReady;
      core.bindOwner(document);privateExecutionOwners.set(document,{core,held,ownership,assertCurrent:execution!.assertCurrent,retainTask(domain,history,onRevoke){
        if(selectedAdmissions||queue.length||scheduled)throw new FactRecoveryRequiredError();
        const revision=metadataRevision, capturedPrefix=prefix, header=core.header, artifacts=assertOriginalManagedTaskHistory(domain,history);let revoked=false
        const listener=()=>{if(revoked)return;revoked=true;onRevoke()}
        const current=()=>{if(revoked||closed||closing||metadataStale||metadataRevision!==revision||pending||quarantined||sourceFault||recoveryHolds.size||prefix!==capturedPrefix)throw new FactRecoveryRequiredError();execution!.assertCurrent();held.assertHeld();assertOriginalManagedTaskHistory(domain,history)}
        current();selectedListeners.add(listener)
        const witness:ManagedTaskSourceRead=Object.freeze({kind:'managed-task-source',sessionId:id,document,held,header,artifacts,prefix:Object.freeze({...capturedPrefix}),assertCurrent(){if(this!==witness)throw new TypeError('Original Task source receiver required');current()},unsubscribe(){if(this!==witness)throw new TypeError('Original Task source receiver required');revoked=true;selectedListeners.delete(listener)}})
        managedTaskSourceReads.add(witness);return witness
      },materialize(events){
        if(!Object.hasOwn(document,'view')){const compatibility=core.materialize(events,document);originalDelivery!.bindView(compatibility.view);bindPublicState(compatibility);publicObservation=compatibility}return document;
      },beginTaskMetadata:beginTaskMetadataUpdate,captureTaskParent:()=>privateTaskParent(),captureRequiredParent:source=>privateTaskParent(source),invalidateMetadata(revision){metadataRevision=revision;metadataStale=true;invalidateSelected();try{execution!.assertCurrent()}catch(error){core.readinessUnavailable(error,true)}},parent(){
        Reflect.apply(originalReady,document,[]);const revision=metadataRevision;
        const rawCheck=()=>{
          if(closed||metadataStale||metadataRevision!==revision||Object.getOwnPropertyDescriptor(document,'assertReady')?.value!==originalReady||pending||quarantined)throw new FactRecoveryRequiredError();
          execution!.assertCurrent();held.assertHeld();
          Reflect.apply(originalReady,document,[]);
        };const check=originalGuardDependencies&&isArtifactCurrentGuard(originalReady)?createArtifactCurrentGuard(()=>{assertGuardMethods();rawCheck()}):()=>withImmediateArtifactCurrentChecks(rawCheck);check();const proof=Object.freeze({assertOriginal(){if(this!==proof)throw TypeError('Invalid original parent');check()},assertCurrent(){if(this!==proof)throw TypeError('Invalid original parent');check()},assertTask14Ready(){if(this!==proof)throw TypeError('Invalid original parent');check();if(formatVersion!==14)throw new FactRecoveryRequiredError()}});return proof;
      }});return document;
    }
    function bindPublicState(compatibility: {view:SessionView;observe(suffix:readonly import('@i-harness/core-session').SessionEvent[],report:(error:unknown)=>void):void}) {
    const state=compatibility;
    if(!Object.hasOwn(document,'view'))Object.defineProperty(document,'view',{value:state.view,enumerable:true,writable:false,configurable:false});
    for(const source of sourceDrains.keys())if('delivery'in source)bindFactSettlementSource(state.view,document,source,id);
    const originalReady = document.assertReady, originalView = state!.view;
    readyOwners.set(document, { ownership, invalidateMetadata(revision){metadataRevision=revision;metadataStale=true;invalidateSelected()}, captureProcess(documentKeys, checkEntry) {
        if (!processLatches) throw new FactRecoveryRequiredError();
        const latch = processLatches.capture({ sessionId: id, documentKeys, mode: 'managed', managedOwner: owner });
        const view = state.view, header = view.header, events = view.events;
        let delivered = prefix, count = events.length, failed = false, retired = false;
        const check = () => {
            try {
                const viewProperty = Object.getOwnPropertyDescriptor(document, 'view');
                const readyProperty = Object.getOwnPropertyDescriptor(document, 'assertReady');
                if (metadataStale || failed || retired || !bootstrapReady || pending || queue.length || quarantined || sourceFault || recoveryHolds.size || closing || closed
                    || formatVersion !== CURRENT_FORMAT_VERSION || header?.semanticSeed !== undefined
                    || (header?.seedLength !== undefined && header.seedLength !== 0)
                    || !viewProperty || !('value' in viewProperty) || viewProperty.value !== view
                    || !readyProperty || !('value' in readyProperty) || readyProperty.value !== originalReady
                    || state.view !== view || view.header !== header || view.events !== events
                    || prefix.eventCount !== events.length || prefix.eventCount < count || prefix.bodyBytes < delivered.bodyBytes
                    || (prefix.eventCount === count && prefix !== delivered)) throw new FactRecoveryRequiredError();
                checkEntry(); latch.assertCurrent(); assertAuthorized(rootAuthorization);
            } catch (error) { failed = true; throw error; }
        };
        try { check(); } catch (error) { latch.retire(); throw error; }
        const initial: SessionView = Object.freeze({ ...view, events: Object.freeze([...events]) });
        const result: ManagedProcessCapture = Object.freeze({ initial,
            assertHealthy() { if (this !== result) { failed = true; throw new TypeError('Invalid process capture receiver'); } check(); },
            take() {
                if (this !== result) throw new TypeError('Invalid process capture receiver');
                check();
                if (prefix === delivered) return Object.freeze({ kind: 'unchanged' as const, highWater: count });
                const from = count, to = prefix.eventCount, suffix = Object.freeze(events.slice(from, to));
                if (to <= from || suffix.length !== to - from) { failed = true; throw new FactRecoveryRequiredError(); }
                delivered = prefix; count = to;
                return Object.freeze({ kind: 'suffix' as const, from, to, events: suffix });
            },
            assertDrained() {
                if (this !== result) throw new TypeError('Invalid process capture receiver');
                check();
                if (prefix !== delivered || events.length !== count) { failed = true; throw new FactRecoveryRequiredError(); }
            },
            markVerified() { if (this !== result) throw new TypeError('Invalid process capture receiver'); result.assertDrained(); latch.markVerified(); },
            close() { if (this !== result) throw new TypeError('Invalid process capture receiver'); retired = true; latch.retire(); },
        });
        return result;
    }, beginTaskMetadata() {return beginTaskMetadataUpdate()}, captureTaskParent() {
        const revision=taskRevision;
        const checkOriginal=()=>{
            const ready=Object.getOwnPropertyDescriptor(document,'assertReady'),view=Object.getOwnPropertyDescriptor(document,'view');
            if(closed||taskMetadataPending||taskMetadataStale||revision!==taskRevision||!ready||!('value'in ready)||ready.value!==originalReady||!view||!('value'in view)||view.value!==originalView||state.view!==originalView)throw new FactRecoveryRequiredError();
            held.assertHeld();
        };
        const check=()=>{checkOriginal();Reflect.apply(originalReady,document,[])};check();
        const result=Object.freeze({view:originalView,assertOriginal(){if(this!==result)throw TypeError('Invalid Task parent receiver');checkOriginal()},assertCurrent(){if(this!==result)throw TypeError('Invalid Task parent receiver');check()},assertTask14Ready(){if(this!==result)throw TypeError('Invalid Task parent receiver');check();if(formatVersion!==14)throw new FactRecoveryRequiredError()}});return result;
    }, captureRequiredParent(source) {
        const original=sourceDrains.get(source);if(!original?.action||original.action.stopped||original.closeRequested||!original.sourceMethods||!original.deliveryMethods||formatVersion!==14||Object.getOwnPropertyDescriptor(document,'assertReady')?.value!==originalReady)throw new FactRecoveryRequiredError();Reflect.apply(originalReady,document,[]);
        const sourceMethods=original.sourceMethods,deliveryMethods=original.deliveryMethods;
        const assertSource=()=>{for(const [object,fields]of [[source,sourceMethods],[sourceMethods.delivery!.value as object,deliveryMethods]]as const){for(const key of Reflect.ownKeys(fields)){const original=Reflect.get(fields,key)as PropertyDescriptor,now=Object.getOwnPropertyDescriptor(object,key);if(!now||!('value'in now)||now.value!==original.value)throw new FactRecoveryRequiredError()}}source.assertHeld()};
        const revision=taskRevision;
        const checkIdentity=()=>{if(closed||taskMetadataPending||taskMetadataStale||revision!==taskRevision||!sourceDrains.has(source)||state.view!==originalView||Object.getOwnPropertyDescriptor(document,'assertReady')?.value!==originalReady||Object.getOwnPropertyDescriptor(document,'view')?.value!==originalView||quarantined||sourceFault)throw new FactRecoveryRequiredError();assertSource();held.assertHeld()};
        const check=()=>{checkIdentity();if(pending)throw new FactRecoveryRequiredError()};check();
        return captureRequiredWriterProof(source,checkIdentity,check,{view:originalView});
    }, captureParent() {
        const revision = metadataRevision;
        const check = () => {
            const ready = Object.getOwnPropertyDescriptor(document, 'assertReady');
            const view = Object.getOwnPropertyDescriptor(document, 'view');
            if (metadataStale || revision!==metadataRevision || !ready || !('value' in ready) || ready.value !== originalReady || !view || !('value' in view) || view.value !== originalView || state.view !== originalView) throw new FactRecoveryRequiredError();
            Reflect.apply(originalReady, document, []);
        };
        check();
        const result = Object.freeze({ view: originalView, assertOriginal(){if(this!==result||closed||metadataStale||revision!==metadataRevision||Object.getOwnPropertyDescriptor(document,'view')?.value!==originalView||state.view!==originalView||Object.getOwnPropertyDescriptor(document,'assertReady')?.value!==originalReady)throw new FactRecoveryRequiredError();held.assertHeld()}, assertCurrent() {
            if (this !== result) throw new TypeError('Invalid parent readiness receiver');
            check();
        }, assertTask14Ready() {
            if (this !== result) throw new TypeError('Invalid parent readiness receiver');
            check(); if (formatVersion !== 14) throw new FactRecoveryRequiredError();
        } });
        return result;
    }, retainSelected(onRevoke) {
        if(selectedAdmissions||queue.length||scheduled)throw new FactRecoveryRequiredError();
        const original=captureManagedReadyObservation(document,ownership),header=original.view.header;
        let revoked=false;
        const listener=()=>{if(revoked)return;revoked=true;onRevoke()};selectedListeners.add(listener);
        return Object.freeze({...original,header,assertCurrent(){if(revoked)throw new FactRecoveryRequiredError();original.assertCurrent()},unsubscribe(){revoked=true;selectedListeners.delete(listener)}});
    }, capture() {
        const view = state.view, events = view.events, eventCount = events.length, originalPrefix = prefix, header = view.header, revision=metadataRevision;
        const assertCurrent = () => {
            if (metadataStale || revision!==metadataRevision || !bootstrapReady || pending || quarantined || document.view !== view || state.view !== view || view.events !== events || events.length !== eventCount
                || view.header !== header || prefix !== originalPrefix || prefix.eventCount !== eventCount) throw new FactRecoveryRequiredError();
            assertAuthorized(rootAuthorization);
        };
        assertCurrent();
        return Object.freeze({ document, held, view, events, eventCount, prefix: Object.freeze({ ...originalPrefix }), assertCurrent });
    } });
    }
    state!.bindOwner(document);bindPublicState(state!);
    return document;
}
