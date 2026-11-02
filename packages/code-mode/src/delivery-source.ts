import { randomUUID } from 'node:crypto';
import { committedFactSeqs, FactRecoveryRequiredError, readDeliveries, type CapturedActionFact, type CapturedSettlementFact, type ProducerFactOutcome, type SessionView, type SettlementFacts, type CodeTerminalEvent } from '@i-harness/core-session';
import type { OriginalCodeSourceIssuer } from '@i-harness/core-tools/model-origin';
import type { CompletionHandle, CompletionObservation } from './register.ts';
/** One actual Code execute owns this state; neither observation DTOs nor callers enroll it. */
export function createCodeDeliveryProducer(issuer: OriginalCodeSourceIssuer, view: SessionView, drive: () => Promise<void>, cancel: (cellId: string) => Promise<void>, released: () => void) {
    const sourceId = randomUUID(), returned = Promise.withResolvers<void>();
    let cellId: string | undefined, completion: CompletionHandle | undefined, sourceCapture: CapturedActionFact<ProducerFactOutcome> | undefined, sourceOutcome: ProducerFactOutcome | undefined, sourceSeq: number | undefined, sourceAttempted = false, sourceRetired = false, unsupported = false;
    let terminal: CapturedSettlementFact<ProducerFactOutcome> | undefined, handoff: CapturedSettlementFact<ProducerFactOutcome> | undefined, terminalAttempted = false, handoffAttempted = false, terminalDone = false, handoffDone = false, wantsHandoff = false;
    let settlement: Promise<void> | undefined, closing: Promise<void> | undefined, done = false;
    const settleFact = async (fact: CapturedSettlementFact<ProducerFactOutcome>, attempted: boolean) => {
        let outcome = attempted ? await fact.observe() : await fact.admit();
        if (outcome.kind === 'unknown' || outcome.kind === 'recovery-required' || outcome.kind === 'conflict' || outcome.kind === 'not-issued' && outcome.code === 'FACT_RECOVERY_REQUIRED')
            outcome = await fact.reconcile();
        committedFactSeqs(outcome);
        return outcome;
    };
    const settleSource = async () => {
        if (!sourceCapture || sourceRetired)
            return;
        sourceOutcome = sourceAttempted ? await sourceCapture.observe() : await sourceCapture.admit();
        sourceAttempted = true;
        if (sourceOutcome.kind === 'unknown' || sourceOutcome.kind === 'recovery-required' || sourceOutcome.kind === 'conflict' || sourceOutcome.kind === 'not-issued' && sourceOutcome.code === 'FACT_RECOVERY_REQUIRED')
            sourceOutcome = await sourceCapture.reconcile();
        if (sourceOutcome.kind === 'absent' || sourceOutcome.kind === 'not-issued' && ['FACT_PRECONDITION_STALE', 'FACT_CANCELLED'].includes(sourceOutcome.code)) {
            sourceRetired = true;
            return;
        }
        const seq = committedFactSeqs(sourceOutcome)[0], indexed = readDeliveries(view).source('code', sourceId);
        if (seq === undefined || indexed?.kind !== 'code' || indexed.seq !== seq || indexed.cellId !== cellId)
            throw new FactRecoveryRequiredError();
        sourceSeq = seq;
    };
    const settleHandoff = async () => {
        if (!wantsHandoff || handoffDone || sourceRetired || unsupported)
            return;
        if (sourceSeq === undefined)
            throw new FactRecoveryRequiredError();
        handoff ??= source.delivery.capture({ type: 'agent/delivery-handoff', version: 1, kind: 'code', sourceSeq });
        const already = handoffAttempted;
        handoffAttempted = true;
        await settleFact(handoff, already);
        handoffDone = true;
    };
    const captureTerminal = (observed: CompletionObservation): CodeTerminalEvent => {
        if (sourceSeq === undefined || !cellId || observed.cellId !== cellId)
            throw new FactRecoveryRequiredError();
        const common = { type: 'code/end' as const, version: 1 as const, sourceSeq, cellId };
        if (observed.worker === 'not-acquired')
            return { ...common, execution: { dispatch: 'not-dispatched', outcome: 'unknown' }, reason: 'launch-refused' };
        if (observed.worker !== 'acquired')
            return { ...common, execution: { dispatch: 'unknown', outcome: 'unknown' }, reason: 'launch-unknown' };
        if (observed.evidence) {
            const { header, footer, ref, unavailableTextCount } = observed.evidence;
            const outcome = footer.status === 'completed' ? 'succeeded' as const : footer.status === 'failed' || footer.status === 'replanned' || footer.status === 'policy-refused' ? 'failed' as const : footer.status === 'terminated' ? 'canceled' as const : 'unknown' as const;
            return { ...common, execution: { dispatch: 'dispatched', outcome }, result: { kind: 'artifact', ref }, output: { header, footer, unavailableTextCount } };
        }
        return { ...common, execution: { dispatch: 'dispatched', outcome: 'unknown' }, result: observed.disposition?.kind === 'unavailable' ? { kind: 'unavailable', reason: observed.disposition.reason } : { kind: 'unavailable', reason: 'unsupported-owner' } };
    };
    const settle = () => {
        if (settlement)
            return settlement;
        const flight = (async () => {
            await returned.promise;
            await settleSource();
            if (unsupported || sourceRetired || !sourceCapture)
                return;
            source.assertHeld();
            await drive();
            if (!completion)
                throw new FactRecoveryRequiredError();
            const observed = await completion.settle();
            await settleHandoff();
            terminal ??= source.delivery.capture(captureTerminal(observed));
            if (!terminalDone) {
                const attempted = terminalAttempted;
                terminalAttempted = true;
                await settleFact(terminal, attempted);
                terminalDone = true;
            }
        })();
        settlement = flight;
        void flight.then(() => {
            if (settlement === flight)
                settlement = undefined;
        }, () => {
            if (settlement === flight)
                settlement = undefined;
        });
        return flight;
    };
    const source: SettlementFacts<ProducerFactOutcome> = issuer.registerCompletion(async () => {
        await returned.promise;
        if (cellId && !terminalDone && !unsupported && !sourceRetired && sourceCapture)
            await cancel(cellId);
        await settle();
    });
    const close = () => {
        if (done)
            return Promise.resolve();
        if (closing)
            return closing;
        const flight = source.close().then(() => { done = true; released(); });
        closing = flight;
        void flight.catch(() => {
            if (closing === flight)
                closing = undefined;
        });
        return flight;
    };
    const finish = () => {
        returned.resolve();
        void settle().then(close, () => {
            try {
                source.holdRecovery();
            }
            catch { /* Original source retains failed close. */ }
        }).catch(() => { });
    };
    return Object.freeze({
        unsupported() {
            if (cellId || sourceCapture)
                throw Error('Original Code source already started');
            unsupported = true;
        },
        async started(id: string, handle: CompletionHandle) {
            if (cellId)
                throw Error('Original Code source already started');
            cellId = id;
            completion = handle;
            issuer.assertAdmissionCurrent();
            const prepared = await issuer.prepareLaunch(id, sourceId);
            issuer.assertAdmissionCurrent();
            if (!prepared.isCurrent())
                throw new FactRecoveryRequiredError();
            sourceCapture = issuer.captureSource(prepared.binding, prepared.isCurrent);
            await settleSource();
            if (sourceRetired || sourceSeq === undefined)
                throw new FactRecoveryRequiredError();
            issuer.assertAdmissionCurrent();
            if (!prepared.isCurrent())
                throw new FactRecoveryRequiredError();
        },
        async observed(running: boolean) {
            if (running && !unsupported) {
                issuer.assertAdmissionCurrent();
                wantsHandoff = true;
                await settleHandoff();
                issuer.assertAdmissionCurrent();
            }
            if (running) {
                finish();
                return;
            }
            returned.resolve();
            await settle();
            void close().catch(() => {
                try {
                    source.holdRecovery();
                }
                catch { /* Original owner keeps debt. */ }
            });
        },
        failed() { finish(); }, close,
    });
}
