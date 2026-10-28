import { createDeliveryControl } from '../../../core-session/src/managed/delivery-control.ts';
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
import { cancellationRetirementFor } from './received-input-cancellation.ts';
import { ownBackendOutcome, sameBatchKey } from './fact-outcome.ts';
import { createActionCaptures } from './action-captures.ts';
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
    group?: CapturedFactGroup;
    bootstrap?: { phase: 'seed' | 'completion'; events: readonly import('@i-harness/core-session').SessionEvent[]; batchId: string };
    ticket: Ticket;
    resolve(outcome: FactOutcome): void;
    bytes: number;
    seqs?: readonly number[];
    authorization: Authorization;
};
type Pending = {
    batch: ReturnType<typeof encodeFactBatch>;
    prefix: JournalPrefix;
    entries: Entry[];
    events: ReturnType<typeof resolveFactGroup>;
    install(): void;
    receipt?: FactReceipt;
    issued: boolean;
    cleanupReported?: boolean;
    installationFailure?: { error: unknown };
};
export interface ManagedReadyObservation {
    readonly document: ManagedDocument; readonly held: HeldFactOwner;
    readonly view: SessionView; readonly events: SessionView['events']; readonly eventCount: number;
    readonly prefix: Readonly<JournalPrefix>;
    assertCurrent(): void;
}
type ProcessLatch = { assertCurrent(): void };
type ProcessUpdate = { kind: 'unchanged'; highWater: number } | { kind: 'suffix'; from: number; to: number; events: SessionView['events'] };
type ManagedProcessCapture = { readonly initial: SessionView; take(): ProcessUpdate; assertDrained(): void; close(): void };
const readyOwners = new WeakMap<ManagedDocument, { ownership: Ownership; capture(): ManagedReadyObservation; captureParent(): Readonly<{ view: SessionView; assertCurrent(): void }>; captureProcess(latch: ProcessLatch, checkEntry: () => void): ManagedProcessCapture }>();
export function captureManagedProcessRead(document: ManagedDocument, ownership: Ownership, latch: ProcessLatch, checkEntry: () => void): ManagedProcessCapture {
    const original = readyOwners.get(document);
    if (!original || original.ownership !== ownership) throw new FactRecoveryRequiredError();
    return original.captureProcess(latch, checkEntry);
}
export function captureManagedParentReadiness(document: ManagedDocument, ownership: Ownership) {
    const original = readyOwners.get(document);
    if (!original || original.ownership !== ownership) throw new FactRecoveryRequiredError();
    return original.captureParent();
}
/** Private original-factory observation. No caller-shaped document/owner can issue it. */
export function captureManagedReadyObservation(document: ManagedDocument, ownership: Ownership): ManagedReadyObservation {
    const original = readyOwners.get(document);
    if (!original || original.ownership !== ownership) throw new FactRecoveryRequiredError();
    return original.capture();
}
/** One owned document, one staged suffix, one private Session/index. All disk
 * mutations join the coordinator's existing session operation lane. */
export function createManagedDocument(id: string, source: Session, initialPrefix: JournalPrefix, backend: PersistenceBackend, ownership: Ownership, options: CoordinatorOptions | undefined, report: (error: unknown) => void, bootstrap?: { operationId: string; bind(control: BootstrapDocumentControl): void }): ManagedDocument & {
    assertObservable(): void;
} {
    const state = (bootstrap ? createBootstrapManagedSessionState : createManagedSessionState)(source, { sessionId: id }), incarnation = randomUUID();
    const deliveryControl = createDeliveryControl(state.view);
    let bootstrapReady = !bootstrap;
    const formatVersion = source.formatVersion;
    const owner = Object.freeze({ sessionId: id, incarnation });
    const maxPendingGroups = options?.maxPendingGroups ?? 64, targetBytes = options?.coalesceTargetBytes ?? 262144;
    const capacity = createFactCapacity(maxPendingGroups), queue: Entry[] = [];
    const sourceDrains = new Map<{
        close(): Promise<void>;
    }, { action?: Action; finished?: () => boolean; closeRequested: boolean }>();
    const inputSources = new Set<ReturnType<typeof createReceivedInputSource>>();
    const actionControllers = new Set<AbortController>();
    const ownedActions = new WeakSet<object>();
    const sourceDispositions = new WeakMap<CapturedFactGroup, FactOutcome>();
    const recoveryHolds = new Set<object>();
    let prefix = initialPrefix, pending: Pending | undefined, closing = false, closed = false, scheduled = false, quarantined = false, sourceFault = false;
    let pump: Promise<void> = Promise.resolve();
    let settlingFinished: Promise<void> | undefined;
    const held = heldFactOwner(owner, ownership, () => {
        if (closed)
            throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' });
    });
    const assertAuthorized = (authorization: Authorization) => {
        held.assertHeld();
        try { authorization.assertSource?.(); }
        catch (error) {
            const code = (error as { code?: string }).code;
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
        quarantined = true;
        capacity.stop('FACT_RECOVERY_REQUIRED');
        for (const entry of queue.splice(0)) {
            entry.ticket.release();
            entry.resolve({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' });
        }
    };
    const failSource = () => {
        sourceFault = true;
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
            const receipt = outcome.receipt;
            current.receipt = receipt;
            try {
                current.install();
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
                if (entry.group) sourceDispositions.set(entry.group, outcome);
                return outcome;
            });
            return { results, observe: true, cleanupDiagnostic };
        }
        if (outcome.kind === 'unknown' || outcome.kind === 'conflict')
            failQueued();
        else {
            pending = undefined;
            for (const entry of current.entries) {
                entry.ticket.release();
                if (entry.group) sourceDispositions.set(entry.group, outcome);
            }
        }
        return { results: current.entries.map(() => outcome), observe: false };
    };
    const reportCleanup = () => {
        try {
            void Promise.resolve(report(new Error('Managed journal file close failed after sync'))).catch(() => {});
        } catch { /* Diagnostics cannot change the known committed disposition. */ }
    };
    const run = async () => {
        while (queue.length && !pending) {
            let current: Pending | undefined, completed: ReturnType<typeof finish> | undefined;
            await ownership.withSessionOperation(id, async () => {
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
                        const suffix = entry.bootstrap ? [...entry.bootstrap.events] : resolveFactGroup(entry.group!, state.view, prefix.eventCount + events.length);
                        if (entry.bootstrap && suffix.some((event, position) => event.seq !== prefix.eventCount + events.length + position)) throw new TypeError('Invalid bootstrap phase sequence');
                        entry.seqs = Object.freeze(suffix.map(event => event.seq!));
                        entries.push(entry);
                        events.push(...suffix);
                        bytes += entry.bytes;
                    }
                    catch (error) {
                        entry.ticket.release();
                        entry.resolve({ kind: 'not-issued', code: (error as {
                                code?: 'FACT_CLOSED' | 'FACT_CANCELLED' | 'FACT_RECOVERY_REQUIRED';
                            }).code ?? 'FACT_INVALID_GROUP' });
                    }
                }
                if (!entries.length)
                    return;
                try {
                    deliveryControl.assert(events);
                    const staged = state.stage(events);
                    preflightBatchShape(formatVersion, staged.events);
                    const batch = encodeFactBatch(entries[0]!.bootstrap?.batchId ?? randomUUID(), prefix.prefixDigest, staged.events);
                    current = { batch, prefix, entries, events: staged.events, install: staged.install, issued: false };
                    pending = current;
                    const operation = current;
                    const outcome = await backend.appendOwnedBatch!(id, issuingFactOwner(held, () => {
                        if (operation.issued)
                            throw new FactRecoveryRequiredError();
                        for (const entry of entries)
                            assertAuthorized(entry.authorization);
                        deliveryControl.assert(operation.events);
                        operation.issued = true;
                    }), prefix, batch);
                    completed = finish(current, outcome);
                }
                catch (error) {
                    if (current?.issued) {
                        completed = finish(current, { kind: 'unknown', key: current.batch.key });
                    }
                    else {
                        pending = undefined;
                        for (const entry of entries) {
                            entry.ticket.release();
                            const code = (error as { code?: string }).code;
                            entry.resolve({ kind: 'not-issued', code: code === 'FACT_PRECONDITION_STALE' || code === 'FACT_CANCELLED' || code === 'FACT_CLOSED' || code === 'FACT_RECOVERY_REQUIRED' ? code : 'FACT_INVALID_GROUP' });
                        }
                    }
                }
            });
            // The operation lane is released before any observer may append again.
            if (current && completed) {
                for (const [index, entry] of current.entries.entries())
                    entry.resolve(completed.results[index]!);
                if (completed.observe)
                    state.observe(current.events, report);
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
            if (queue.length && !pending)
                schedule();
        });
    };
    async function admit(draft: FactGroupDraft | CapturedFactGroup, authorization: Authorization, captured = false): Promise<FactOutcome> {
        if (!bootstrapReady) return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' };
        if (closed || closing && !authorization.required)
            return { kind: 'not-issued', code: 'FACT_CLOSED' };
        if (!authorization.required && (authorization.action.stopped || authorization.action.signal?.aborted))
            return { kind: 'not-issued', code: 'FACT_CANCELLED' };
        if (quarantined || (sourceFault || recoveryHolds.size > 0) && !authorization.required)
            return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' };
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
            queue.push({ group: capture.group, bytes, ticket, resolve, authorization });
            schedule();
        });
    }
    const rootAuthorization: Authorization = { action: { stopped: false }, required: false };
    const ports = createFactPorts(draft => admit(draft, rootAuthorization));
    const document: ManagedDocument & {
        assertObservable(): void;
    } = {
        importSeed: events => admit({ kind: 'seed-import', events }, rootAuthorization),
        assertReady() {
            if (!bootstrapReady) throw new FactRecoveryRequiredError();
            assertAuthorized(rootAuthorization);
        },
        revokeNewWork() {
            deliveryControl.retire();
            closing = true;
            capacity.revokeNewWork();
            for (const source of inputSources)
                source.revoke();
            for (const controller of actionControllers)
                controller.abort();
        },
        ...ports,
        registerReceivedInputSource(drain) {
            if (!bootstrapReady) throw new FactRecoveryRequiredError();
            assertAuthorized(rootAuthorization);
            const required: Authorization = { action: { stopped: false }, required: true, assertSource: () => source.assertHeld() };
            const source = createReceivedInputSource(drain, {
                owner, deliveryControl,
                guarded(checkCurrent) {
                    const guarded = {...required,source:{},assertSource() {source.assertHeld();if(!checkCurrent())throw Object.assign(new Error("FACT_PRECONDITION_STALE"),{code:"FACT_PRECONDITION_STALE"})}};
                    return {assertHeld:held.assertHeld,admit:group=>{sourceDispositions.delete(group);return admit(group,guarded,true)},reconcile:key=>document.reconcile(key),status:group=>sourceDispositions.get(group),quarantineCapture:failSource};
                },
                cancellationRetirement: cancellationRetirementFor(state.view, document),
                assertHeld: held.assertHeld, admit: group => {
                    sourceDispositions.delete(group);
                    return admit(group, required, true);
                },
                reconcile: key => document.reconcile(key), status: group => sourceDispositions.get(group), quarantineCapture: failSource,
            }, () => {
                sourceDrains.delete(source);
                inputSources.delete(source);
            });
            required.source = source;
            sourceDrains.set(source, { closeRequested: false });
            inputSources.add(source);
            return source;
        },
        beginAction(signal) {
            if (!bootstrapReady) throw new FactRecoveryRequiredError();
            const cancel = new AbortController();
            let finished = false;
            const action: Action = { signal: signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal, stopped: false, cancel }, authorization = { action, required: false };
            assertAuthorized(authorization);
            actionControllers.add(cancel);
            const capability: import('@i-harness/core-session').ManagedAction<FactOutcome> = {
                signal: action.signal!,
                facts: createFactPorts(draft => admit(draft, authorization)),
                ...createActionCaptures({
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
                    return { assertHeld: held.assertHeld, admit: group => {
                        sourceDispositions.delete(group);
                        return admit(group, guarded, true);
                    }, reconcile: key => document.reconcile(key), status: group => sourceDispositions.get(group), quarantineCapture: failSource };
                }),
                assertOpen: () => assertAuthorized(authorization), stop() {
                    action.stopped = true;
                    cancel.abort();
                },
                finish() {
                    finished = true;
                    action.stopped = true;
                    actionControllers.delete(cancel);
                },
                registerSettlementSource(drain, reconcilePending, checkpointOwner) {
                    assertAuthorized(authorization);
                    const required: Authorization = { action, required: true, assertSource: () => source.assertHeld() };
                    const source = createSettlementSource(drain, {
                        assertHeld: held.assertHeld,
                        admitCaptured: group => {
                            sourceDispositions.delete(group);
                            return admit(group, required, true);
                        },
                        reconcile: key => document.reconcile(key), status: group => sourceDispositions.get(group),
                        quarantineCapture: failSource,
                        onCloseRequested() {
                            const entry = sourceDrains.get(source);
                            if (entry) entry.closeRequested = true;
                        },
                        holdRecovery() {
                            if (!sourceDrains.has(source)) throw new FactRecoveryRequiredError();
                            recoveryHolds.add(source); capacity.holdOptional(source);
                            for (let index = queue.length - 1; index >= 0; index--) {
                                const entry = queue[index]!; if (entry.authorization.required) continue;
                                queue.splice(index, 1); entry.ticket.release(); entry.resolve({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' });
                            }
                        },
                        releaseRecovery() { recoveryHolds.delete(source); capacity.releaseOptional(source) },
                    }, () => { sourceDrains.delete(source); recoveryHolds.delete(source); capacity.releaseOptional(source) }, reconcilePending, checkpointOwner);
                    required.source = source;
                    bindFactSettlementSource(state.view, document, source, id);
                    sourceDrains.set(source, { action, finished: () => finished, closeRequested: false });
                    return source;
                },
            };
            Object.defineProperty(capability, 'owner', { value: owner, enumerable: true, writable: false, configurable: false });
            ownedActions.add(capability);
            return capability;
        },
        ownsAction: action => ownedActions.has(action),
        assertObservable() {
            if (!bootstrapReady || pending || quarantined)
                throw new FactRecoveryRequiredError();
        },
        view: state.view,
        async reconcile(key) {
            let current: Pending | undefined, completed: ReturnType<typeof finish> | undefined;
            await ownership.withSessionOperation(id, async () => {
                current = pending;
                if (!current || !sameBatchKey(key, current.batch.key))
                    return;
                held.assertHeld();
                const outcome = current.receipt ? { kind: 'committed' as const, receipt: current.receipt }
                    : await backend.reconcileOwnedBatch!(id, held, current.prefix, current.batch);
                completed = finish(current, outcome);
            });
            if (!current || !completed)
                return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' };
            if (completed.observe)
                state.observe(current.events, report);
            if (completed.cleanupDiagnostic) reportCleanup();
            if (!pending) {
                quarantined = false;
                capacity.resume();
            }
            return completed.results[0]!;
        },
        async drain() {
            await pump;
            if (pending || quarantined || sourceFault)
                throw new FactRecoveryRequiredError();
        },
        settleFinishedActions() {
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
        async close() {
            if (closed)
                return;
            document.revokeNewWork();
            const drains = await Promise.allSettled([...sourceDrains.keys()].map(source => source.close()));
            await pump;
            if (pending || quarantined || sourceFault || recoveryHolds.size || drains.some(result => result.status === 'rejected'))
                throw new FactRecoveryRequiredError();
            closed = true;
        },
    };
    bootstrap?.bind({ held, ready() { bootstrapReady = true; },
        async admit(phase, events, guards) {
            const assertSource = () => { if (guards.signal?.aborted) throw Object.assign(new Error('FACT_CANCELLED'), { code: 'FACT_CANCELLED' }); guards.assertCurrent(); };
            const authorization: Authorization = { action: { stopped: false, signal: guards.signal }, required: false, source: bootstrap, assertSource };
            if (pending || quarantined || closed || closing) return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' };
            const ticket = await capacity.acquire(guards.signal);
            if (typeof ticket === 'string') return { kind: 'not-issued', code: ticket };
            try { assertAuthorized(authorization); } catch (error) { ticket.release(); return {kind:'not-issued',code:(error as {code?: 'FACT_CANCELLED'}).code ?? 'FACT_PRECONDITION_STALE'}; }
            return new Promise(resolve => { queue.push({ bootstrap: {phase, events, batchId: 'bootstrap:' + bootstrap.operationId + ':' + (phase === 'seed' ? 'seed' : 'complete')}, ticket, resolve, bytes: Buffer.byteLength(stringifyJsonData(events)!), authorization }); schedule(); });
        }
    });
    state.bindOwner(document);
    const originalReady = document.assertReady, originalView = state.view;
    readyOwners.set(document, { ownership, captureProcess(latch, checkEntry) {
        const view = state.view, header = view.header, events = view.events;
        let delivered = prefix, count = events.length, failed = false, retired = false;
        const check = () => {
            try {
                const viewProperty = Object.getOwnPropertyDescriptor(document, 'view');
                const readyProperty = Object.getOwnPropertyDescriptor(document, 'assertReady');
                if (failed || retired || !bootstrapReady || pending || queue.length || quarantined || sourceFault || recoveryHolds.size || closing || closed
                    || formatVersion !== CURRENT_FORMAT_VERSION || header?.semanticSeed !== undefined
                    || !viewProperty || !('value' in viewProperty) || viewProperty.value !== view
                    || !readyProperty || !('value' in readyProperty) || readyProperty.value !== originalReady
                    || state.view !== view || view.header !== header || view.events !== events
                    || prefix.eventCount !== events.length || prefix.eventCount < count || prefix.bodyBytes < delivered.bodyBytes
                    || (prefix.eventCount === count && prefix !== delivered)) throw new FactRecoveryRequiredError();
                checkEntry(); latch.assertCurrent(); assertAuthorized(rootAuthorization);
            } catch (error) { failed = true; throw error; }
        };
        check();
        const initial: SessionView = Object.freeze({ ...view, events: Object.freeze([...events]) });
        const result: ManagedProcessCapture = Object.freeze({ initial,
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
            close() { if (this !== result) throw new TypeError('Invalid process capture receiver'); retired = true; },
        });
        return result;
    }, captureParent() {
        const check = () => {
            const ready = Object.getOwnPropertyDescriptor(document, 'assertReady');
            const view = Object.getOwnPropertyDescriptor(document, 'view');
            if (!ready || !('value' in ready) || ready.value !== originalReady || !view || !('value' in view) || view.value !== originalView || state.view !== originalView) throw new FactRecoveryRequiredError();
            Reflect.apply(originalReady, document, []);
        };
        check();
        const result = Object.freeze({ view: originalView, assertCurrent() {
            if (this !== result) throw new TypeError('Invalid parent readiness receiver');
            check();
        } });
        return result;
    }, capture() {
        const view = state.view, events = view.events, eventCount = events.length, originalPrefix = prefix, header = view.header;
        const assertCurrent = () => {
            if (!bootstrapReady || pending || quarantined || document.view !== view || state.view !== view || view.events !== events || events.length !== eventCount
                || view.header !== header || prefix !== originalPrefix || prefix.eventCount !== eventCount) throw new FactRecoveryRequiredError();
            assertAuthorized(rootAuthorization);
        };
        assertCurrent();
        return Object.freeze({ document, held, view, events, eventCount, prefix: Object.freeze({ ...originalPrefix }), assertCurrent });
    } });
    return document;
}
