import { AsyncLocalStorage } from 'node:async_hooks';
import { committedFactSeqs, createNondurableFactOwner, isManagedFactOwner, isNondurableSession, type CapturedActionFact, type CapturedSettlementFact, type FactOwner, type ManagedAction, type ProducerFactOutcome, type SessionEvent, type SessionView } from '@i-harness/core-session';
import type { TeamEvent } from './types.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Ack, Failure, InstallAck, MailboxResult, MessageObligation, Queued } from './transact.ts';
export function teamFactOwner(view: SessionView, supplied?: FactOwner): FactOwner {
    const owner = supplied ?? (isNondurableSession(view) ? createNondurableFactOwner(view) : undefined);
    if (!owner || owner.view !== view || !isNondurableSession(view) && !isManagedFactOwner(view, owner))
        throw Object.assign(new Error('Team requires its actual document owner'), { code: 'FACT_OWNER_UNSUPPORTED' });
    return owner;
}
/** Tool cancellation context is scheduling data, never a write capability. */
export function createTeamFacts(owner: FactOwner, drainTransactions: () => Promise<void>, committed: () => void, retainFactsCleanup?: (close: () => Promise<void>) => void) {
    const signals = new AsyncLocalStorage<Run>();
    type Transaction = {
        kind: 'transaction';
        action: ManagedAction<ProducerFactOutcome>;
        fact: CapturedActionFact<ProducerFactOutcome>;
        attempted: boolean;
    };
    type Message = MessageObligation & { kind: 'message'; failed(error: unknown): void };
    type Run = { kind: 'run'; action: ManagedAction<ProducerFactOutcome>; active: boolean; done: Promise<void> };
    const transactions = new Map<readonly TeamEvent[], Transaction | Message | Run>();
    let retired = false;
    const action = owner.beginAction();
    let source: ReturnType<typeof action.registerSettlementSource> | undefined;
    let actionFinished = false, sourceClosed = false, initializing = true;
    const finishAction = () => { if (!actionFinished) { action.finish(); actionFinished = true; } };
    const close = async () => {
        retired = true;
        const failures: unknown[] = [];
        try { finishAction(); } catch (error) { failures.push(error); }
        try { if (source && !sourceClosed) { await source.close(); sourceClosed = true; } } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'Team facts cleanup incomplete');
    };
    try {
        retainFactsCleanup?.(close);
        source = action.registerSettlementSource(() => signals.exit(() => initializing && transactions.size === 0 ? Promise.resolve() : drainTransactions()));
        finishAction();
        initializing = false;
    } catch (error) {
        // The mount owns staged retries. Standalone callers still finish an
        // action whose registration refused before returning a facts facade.
        if (!retainFactsCleanup) {
            try { finishAction(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Team facts construction and cleanup failed', { cause: error }); }
        }
        throw error;
    }
    const assertOpen = () => { if (retired) throw Object.assign(new Error('Team message admission is closed'), { code: 'FACT_CLOSED' }); };
    const currentRunSignal = () => {
        const run = signals.getStore();
        if (run) {
            if (!run.active) throw Object.assign(new Error('Team operation has finished'), { code: 'FACT_CLOSED' });
            run.action.assertOpen();
        }
        return run?.action.signal;
    };
    const beginCandidate = () => {
        assertOpen();
        const candidate = owner.beginAction(currentRunSignal());
        let adopted = false, finished = false;
        const abandon = () => { if (!adopted && !finished) { finished = true; candidate.finish(); } };
        try { candidate.assertOpen(); } catch (error) { abandon(); throw error; }
        return {
            capture(events: readonly TeamEvent[]) {
                if (adopted || finished) throw new Error('Team candidate already transferred or abandoned');
                try {
                    const fact = candidate.captureTeamTransaction(events);
                    transactions.set(events, { kind: 'transaction', action: candidate, fact, attempted: false });
                    adopted = true;
                } catch (error) { abandon(); throw error; }
            },
            abandon,
        };
    };
    const findMessage = (queued: Queued) => {
        for (const record of transactions.values()) {
            if (record.kind !== 'message' || record.queueEvents[0].message.id !== queued.message.id) continue;
            if (!isDeepStrictEqual(record.queueEvents[0], queued)) throw new Error('Team message tuple mismatch');
            return record;
        }
    };
    return {
        run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
            assertOpen();
            const action = owner.beginAction(signal);
            try { action.assertOpen(); } catch (error) { action.finish(); throw error; }
            // Retain accepted outer work before its first acquisition await.
            // The original caller still owns its result/error; cleanup joins a
            // resolving sentinel and never invokes the work a second time.
            const key: readonly TeamEvent[] = [], done = Promise.withResolvers<void>();
            const run: Run = { kind: 'run', action, active: true, done: done.promise };
            transactions.set(key, run);
            const release = () => {
                try { action.finish(); }
                finally { run.active = false; transactions.delete(key); done.resolve(); }
            };
            try {
                const running = signals.run(run, work);
                return running.then(value => { release(); return value; }, error => { release(); throw error; });
            } catch (error) { release(); throw error; }
        },
        withoutRun<T>(work: () => T): T { return signals.exit(work); },
        beginCandidate,
        async joinRuns(): Promise<void> {
            // Only the external retiring owner joins outer work. In particular,
            // the native source producer must not join an operation awaiting it.
            await Promise.all([...transactions.values()].filter(record => record.kind === 'run').map(record => record.done));
        },
        async commit(events: readonly TeamEvent[]) {
            let pending = transactions.get(events);
            if (pending?.kind === 'message') throw new Error('Message queue is not a generic transaction');
            if (pending?.kind === 'run') throw new Error('Team operation is not a generic transaction');
            if (!pending) {
                const candidate = beginCandidate();
                try { candidate.capture(events); } finally { candidate.abandon(); }
                pending = transactions.get(events) as Transaction;
            }
            const attempted = pending.attempted;
            pending.attempted = true;
            const outcome = await (attempted ? pending.fact.reconcile() : pending.fact.admit());
            if (pending.action.signal.aborted && (outcome.kind === 'absent' || outcome.kind === 'not-issued')) {
                pending.action.finish();
                transactions.delete(events);
                throw Object.assign(new Error('Team transaction cancelled before commitment'), { code: 'FACT_CANCELLED' });
            }
            committedFactSeqs(outcome);
            pending.action.finish();
            transactions.delete(events);
        },
        findMessage,
        reserveMessage(queued: Queued, mode: 'enqueue' | 'existing', installAck: InstallAck): MessageObligation {
            const existing = findMessage(queued);
            if (existing) return existing;
            assertOpen();
            const signal = currentRunSignal();
            // Clone and freeze the fixed tuple before asynchronous admission.
            const freeze = <T>(value: T): T => {
                if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
                return value;
            };
            const original = freeze(structuredClone(queued));
            const queueEvents = Object.freeze([original]) as readonly [Queued];
            const ack: Ack = Object.freeze({ type: 'team/message/delivered', version: 1, teamId: original.teamId, messageId: original.message.id, targetId: original.message.targetId });
            const admission = owner.beginAction(signal);
            try { admission.assertOpen(); } catch (error) { admission.finish(); throw error; }
            let queueFact: CapturedActionFact<ProducerFactOutcome> | undefined;
            let queueAttempted = false, installed = mode === 'existing', neverIssued = false;
            let driver: Promise<MailboxResult> | undefined, driverDone: Promise<void> | undefined;
            let consumedKnown = false, consumed = false, ackInstalled = false;
            let sendFailure: Failure = { occurred: false }, errorDelivered = false;
            let settlementFailure: Failure = { occurred: false };
            let ackFact: CapturedSettlementFact<ProducerFactOutcome> | undefined;
            let ackAttempted = false;
            let ackSettlement: Promise<void> | undefined;
            const finishNoAck = () => { admission.finish(); transactions.delete(queueEvents); };
            const settleAck = (): Promise<void> => {
                // Concurrent drains join this record's same lane installation,
                // including its receipt and observer outcome. Never enqueue a
                // second installer while the first one is awaiting reconciliation.
                if (ackSettlement) return ackSettlement;
                if (ackInstalled) return Promise.resolve();
                const attempt = (async () => {
                    try {
                        await installAck(async () => {
                            ackFact ??= source!.delivery.capture(ack);
                            const fact = ackFact;
                            const retry = ackAttempted;
                            ackAttempted = true;
                            committedFactSeqs(await (retry ? fact.reconcile() : fact.admit()));
                        }, () => { ackInstalled = true; });
                        settlementFailure = { occurred: false };
                    } catch (error) { settlementFailure = { occurred: true, error }; throw error; }
                })();
                ackSettlement = attempt;
                const release = () => { if (ackSettlement === attempt) ackSettlement = undefined; };
                void attempt.then(release, release);
                return attempt;
            };
            const record: Message = {
                kind: 'message', queueEvents,
                async queue() {
                    if (installed) return;
                    if (neverIssued && sendFailure.occurred) throw sendFailure.error;
                    const retry = queueAttempted;
                    queueAttempted = true;
                    const outcome = await (retry ? queueFact!.reconcile() : queueFact!.admit());
                    if (outcome.kind === 'not-issued') {
                        neverIssued = true;
                        finishNoAck();
                        // Preserve the native refusal while telling the lane to release its slot.
                        try { committedFactSeqs(outcome); }
                        catch (error) {
                            sendFailure = { occurred: true, error };
                            errorDelivered = true;
                            throw Object.assign(error as Error, { teamQueueNotIssued: true });
                        }
                    }
                    committedFactSeqs(outcome);
                },
                queueInstalled() { installed = true; },
                failed(error) { sendFailure = { occurred: true, error }; errorDelivered = true; },
                start(deliver) {
                    if (driver) return driver;
                    if (errorDelivered && sendFailure.occurred) return Promise.reject(sendFailure.error);
                    const done = Promise.withResolvers<void>();
                    driverDone = done.promise;
                    driver = (async () => {
                        try {
                            // No await may separate the original action guard from dispatch.
                            assertOpen(); admission.assertOpen(); admission.finish();
                            const outcome = await deliver();
                            consumedKnown = true;
                            consumed = outcome.kind === 'consumed';
                            sendFailure = outcome.sendFailure;
                            if (consumed) {
                                try { await settleAck(); }
                                catch (error) { if (!sendFailure.occurred) throw error; }
                            } else finishNoAck();
                            if (sendFailure.occurred) { errorDelivered = true; throw sendFailure.error; }
                            return { messageId: original.message.id, status: consumed ? 'accepted' as const : 'queued' as const };
                        } catch (error) {
                            if (!consumedKnown) { consumedKnown = true; consumed = false; finishNoAck(); }
                            if (!sendFailure.occurred) sendFailure = { occurred: true, error };
                            errorDelivered = true;
                            throw error;
                        } finally { done.resolve(); }
                    })();
                    return driver;
                },
                async settle() {
                    await driverDone;
                    if (!consumedKnown) {
                        // Receipt recovery of a failed send cannot dispatch its unreached callback.
                        if (!installed && !neverIssued) throw new Error('Message queue installation needs recovery');
                        consumedKnown = true; consumed = false; finishNoAck();
                    }
                    if (consumed && !ackInstalled) await settleAck();
                    // Historic caller failure is separate from current receipt/install debt.
                    if (!ackInstalled && settlementFailure.occurred) throw settlementFailure.error;
                },
            };
            transactions.set(queueEvents, record);
            try { if (mode === 'enqueue') queueFact = admission.captureTeamTransaction(queueEvents); }
            catch (error) { finishNoAck(); throw error; }
            return record;
        },
        async settleMessages() {
            for (const record of [...transactions.values()]) if (record.kind === 'message') await record.settle();
        },
        messageFailed(record: MessageObligation, error: unknown) {
            const original = transactions.get(record.queueEvents);
            if (original?.kind === 'message') original.failed(error);
        },
        retire() { retired = true; },
        onCommit: committed,
        close,
    };
}
/** A queued message retains the same target capture until acknowledgement. */
export function createTeamDeliveryFacts() {
    type Pending = {
        fact: CapturedSettlementFact<ProducerFactOutcome>;
        settle(): Promise<void>;
        close(): Promise<void>;
    };
    const owners = new WeakMap<FactOwner, Map<string, Pending>>();
    return async (owner: FactOwner, event: Extract<SessionEvent, {
        type: 'subagent/inbox';
    }>) => {
        let pending = owners.get(owner);
        if (!pending) {
            pending = new Map();
            owners.set(owner, pending);
        }
        let record = pending.get(event.messageId);
        if (!record) {
            const action = owner.beginAction();
            const source = action.registerSettlementSource(async () => { await record!.settle(); });
            action.finish();
            const fact = source.delivery.capture(event);
            record = {
                fact,
                async settle() {
                    if (!pending!.has(event.messageId)) return;
                    committedFactSeqs(await fact.reconcile());
                    pending!.delete(event.messageId);
                },
                close: () => source.close(),
            };
            pending.set(event.messageId, record);
        }
        await record.settle();
        await record.close();
    };
}
