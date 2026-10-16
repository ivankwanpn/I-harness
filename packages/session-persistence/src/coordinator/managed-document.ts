import { randomUUID } from 'node:crypto';
import { captureFactGroup, createManagedSessionState, encodeFactBatch, FactRecoveryRequiredError, resolveFactGroup, stringifyJsonData, bindFactSettlementSource, type CapturedFactGroup, type FactGroupDraft, type FactOutcome, type FactReceipt, type JournalPrefix, type Session, } from '@i-harness/core-session';
import type { BackendFactOutcome, ManagedDocument } from './fact-types.ts';
import type { Ownership } from './ownership.ts';
import type { CoordinatorOptions, PersistenceBackend } from './types.ts';
import { createFactCapacity } from './fact-capacity.ts';
import { createFactPorts } from './fact-ports.ts';
import { createSettlementSource } from './settlement-source.ts';
import { heldFactOwner, issuingFactOwner } from './fact-owner.ts';
import { preflightBatchShape } from '../format/validation.ts';
import { createReceivedInputSource } from './received-input-source.ts';
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
    group: CapturedFactGroup;
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
};
/** One owned document, one staged suffix, one private Session/index. All disk
 * mutations join the coordinator's existing session operation lane. */
export function createManagedDocument(id: string, source: Session, initialPrefix: JournalPrefix, backend: PersistenceBackend, ownership: Ownership, options: CoordinatorOptions | undefined, report: (error: unknown) => void): ManagedDocument & {
    assertObservable(): void;
} {
    const state = createManagedSessionState(source), incarnation = randomUUID();
    const formatVersion = source.formatVersion;
    const owner = Object.freeze({ sessionId: id, incarnation });
    const maxPendingGroups = options?.maxPendingGroups ?? 64, targetBytes = options?.coalesceTargetBytes ?? 262144;
    const capacity = createFactCapacity(maxPendingGroups), queue: Entry[] = [];
    const sourceDrains = new Set<{
        close(): Promise<void>;
    }>();
    const inputSources = new Set<ReturnType<typeof createReceivedInputSource>>();
    const actionControllers = new Set<AbortController>();
    const sourceDispositions = new WeakMap<CapturedFactGroup, FactOutcome>();
    let prefix = initialPrefix, pending: Pending | undefined, closing = false, closed = false, scheduled = false, quarantined = false, sourceFault = false;
    let pump: Promise<void> = Promise.resolve();
    const held = heldFactOwner(owner, ownership, () => {
        if (closed)
            throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' });
    });
    const assertAuthorized = (authorization: Authorization) => {
        held.assertHeld();
        authorization.assertSource?.();
        if (quarantined || sourceFault && !authorization.required)
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
    } => {
        const outcome = ownBackendOutcome(backendOutcome, current.batch.key, owner, current.issued);
        if (outcome.kind === 'committed') {
            const receipt = outcome.receipt;
            current.receipt = receipt;
            try {
                current.install();
            }
            catch {
                failQueued();
                return { results: current.entries.map(() => ({ kind: 'recovery-required', code: 'FACT_INSTALL_FAILED', receipt })), observe: false };
            }
            prefix = { eventCount: prefix.eventCount + current.batch.key.count, bodyBytes: prefix.bodyBytes + current.batch.bytes.length, prefixDigest: receipt.prefixDigest };
            pending = undefined;
            const results = current.entries.map(entry => {
                const seqs = entry.seqs!;
                entry.ticket.release();
                const outcome = Object.freeze({ kind: 'committed' as const, receipt, seqs });
                sourceDispositions.set(entry.group, outcome);
                return outcome;
            });
            return { results, observe: true };
        }
        if (outcome.kind === 'unknown' || outcome.kind === 'conflict')
            failQueued();
        else {
            pending = undefined;
            for (const entry of current.entries) {
                entry.ticket.release();
                sourceDispositions.set(entry.group, outcome);
            }
        }
        return { results: current.entries.map(() => outcome), observe: false };
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
                    && queue[0]!.authorization.required === entries[0]!.authorization.required)) {
                    const entry = queue.shift()!;
                    try {
                        assertAuthorized(entry.authorization);
                        const suffix = resolveFactGroup(entry.group, state.view, prefix.eventCount + events.length);
                        entry.seqs = Object.freeze(suffix.map(event => event.seq!));
                        entries.push(entry);
                        events.push(...suffix);
                        bytes += entry.bytes;
                    }
                    catch (error) {
                        entry.ticket.release();
                        entry.resolve({ kind: 'not-issued', code: (error as {
                                code?: 'FACT_CLOSED' | 'FACT_CANCELLED';
                            }).code ?? 'FACT_INVALID_GROUP' });
                    }
                }
                if (!entries.length)
                    return;
                try {
                    const staged = state.stage(events);
                    preflightBatchShape(formatVersion, staged.events);
                    const batch = encodeFactBatch(randomUUID(), prefix.prefixDigest, staged.events);
                    current = { batch, prefix, entries, events: staged.events, install: staged.install, issued: false };
                    pending = current;
                    const operation = current;
                    const outcome = await backend.appendOwnedBatch!(id, issuingFactOwner(held, () => {
                        if (operation.issued)
                            throw new FactRecoveryRequiredError();
                        for (const entry of entries)
                            assertAuthorized(entry.authorization);
                        operation.issued = true;
                    }), prefix, batch);
                    completed = finish(current, outcome);
                }
                catch {
                    if (current?.issued) {
                        completed = finish(current, { kind: 'unknown', key: current.batch.key });
                    }
                    else {
                        pending = undefined;
                        for (const entry of entries) {
                            entry.ticket.release();
                            entry.resolve({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' });
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
        if (closed || closing && !authorization.required)
            return { kind: 'not-issued', code: 'FACT_CLOSED' };
        if (!authorization.required && (authorization.action.stopped || authorization.action.signal?.aborted))
            return { kind: 'not-issued', code: 'FACT_CANCELLED' };
        if (quarantined || sourceFault && !authorization.required)
            return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' };
        const ticket = await capacity.acquire(authorization.required ? undefined : authorization.action.signal, authorization.required);
        if (typeof ticket === 'string')
            return { kind: 'not-issued', code: ticket };
        if (closed || closing && !authorization.required || quarantined || sourceFault && !authorization.required) {
            ticket.release();
            return { kind: 'not-issued', code: quarantined || sourceFault ? 'FACT_RECOVERY_REQUIRED' : 'FACT_CLOSED' };
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
            assertAuthorized(rootAuthorization);
        },
        revokeNewWork() {
            closing = true;
            capacity.revokeNewWork();
            for (const source of inputSources)
                source.revoke();
            for (const controller of actionControllers)
                controller.abort();
        },
        ...ports,
        registerReceivedInputSource(drain) {
            assertAuthorized(rootAuthorization);
            const required: Authorization = { action: { stopped: false }, required: true, assertSource: () => source.assertHeld() };
            const source = createReceivedInputSource(drain, {
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
            sourceDrains.add(source);
            inputSources.add(source);
            return source;
        },
        beginAction(signal) {
            const cancel = new AbortController();
            const action: Action = { signal: signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal, stopped: false, cancel }, authorization = { action, required: false };
            assertAuthorized(authorization);
            actionControllers.add(cancel);
            return {
                signal: action.signal!,
                facts: createFactPorts(draft => admit(draft, authorization)),
                ...createActionCaptures({
                    assertHeld: held.assertHeld,
                    admit: group => {
                        sourceDispositions.delete(group);
                        return admit(group, authorization, true);
                    },
                    reconcile: key => document.reconcile(key), status: group => sourceDispositions.get(group), quarantineCapture: failSource,
                }),
                assertOpen: () => assertAuthorized(authorization), stop() {
                    action.stopped = true;
                    cancel.abort();
                },
                finish() {
                    action.stopped = true;
                    actionControllers.delete(cancel);
                },
                registerSettlementSource(drain, reconcilePending) {
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
                    }, () => sourceDrains.delete(source), reconcilePending);
                    required.source = source;
                    bindFactSettlementSource(state.view, document, source);
                    sourceDrains.add(source);
                    return source;
                },
            };
        },
        assertObservable() {
            if (pending || quarantined)
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
        async close() {
            if (closed)
                return;
            document.revokeNewWork();
            const drains = await Promise.allSettled([...sourceDrains].map(source => source.close()));
            await pump;
            if (pending || quarantined || sourceFault || drains.some(result => result.status === 'rejected'))
                throw new FactRecoveryRequiredError();
            closed = true;
        },
    };
    state.bindOwner(document);
    return document;
}
