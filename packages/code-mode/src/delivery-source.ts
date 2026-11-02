import { isRetiredCodeHandoff } from '../../session-persistence/src/coordinator/settlement-fact.ts'
import { readManagedSourceCodeDelivery, retainAcknowledgedExecutionMembers, type ManagedExecutionDomain } from '@i-harness/core-session/internal/execution'
import { randomUUID } from 'node:crypto';
import { committedFactSeqs, FactRecoveryRequiredError, readDeliveries, type CapturedActionFact, type CapturedSettlementFact, type ProducerFactOutcome, type SessionView, type SettlementFacts, type CodeTerminalEvent } from '@i-harness/core-session';
import type { OriginalCodeSourceIssuer } from '@i-harness/core-tools/model-origin';
import { waitOriginalCompletionFinalization, type CompletionHandle, type CompletionObservation } from './register.ts';
/** One actual Code execute owns this state; neither observation DTOs nor callers enroll it. */
export function createCodeDeliveryProducer(issuer: OriginalCodeSourceIssuer, owner: SessionView | ManagedExecutionDomain, drive: () => Promise<void>, cancel: (cellId: string) => Promise<void>, released: () => void) {
    const sourceId = randomUUID(), returned = Promise.withResolvers<void>();
    let cellId: string | undefined, completion: CompletionHandle | undefined, sourceCapture: CapturedActionFact<ProducerFactOutcome> | undefined, sourceOutcome: ProducerFactOutcome | undefined, sourceSeq: number | undefined, sourceAttempted = false, sourceRetired = false, unsupported = false;
    let terminal: CapturedSettlementFact<ProducerFactOutcome> | undefined, handoff: CapturedSettlementFact<ProducerFactOutcome> | undefined, terminalAttempted = false, handoffAttempted = false, terminalDone = false, handoffDone = false, handoffRefused = false, wantsHandoff = false;
    let sourcePin:ReturnType<typeof retainAcknowledgedExecutionMembers>|undefined,sourceMember:object|undefined;
    let retainedObservation:(()=>void)|undefined,recoverObservation=false;
    const publishObservation=()=>{if(recoverObservation&&handoffDone&&retainedObservation){retainedObservation();retainedObservation=undefined}};
    let settlement: Promise<void> | undefined, closing: Promise<void> | undefined, done = false;
    const settleFact = async (fact: CapturedSettlementFact<ProducerFactOutcome>, attempted: boolean) => {
        let outcome = attempted ? await fact.observe() : await fact.admit();
        if (outcome.kind === 'unknown' || outcome.kind === 'recovery-required' || outcome.kind === 'conflict' || outcome.kind === 'not-issued' && outcome.code === 'FACT_RECOVERY_REQUIRED')
            outcome = await fact.reconcile();
        if(!isRetiredCodeHandoff(fact,outcome))committedFactSeqs(outcome);
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
        const seq = committedFactSeqs(sourceOutcome)[0], indexed = 'identity' in owner ? readManagedSourceCodeDelivery(owner.identity,source,sourceId) : readDeliveries(owner).source('code', sourceId);
        if (seq === undefined || indexed?.kind !== 'code' || indexed.seq !== seq || indexed.cellId !== cellId)
            throw new FactRecoveryRequiredError();
        sourceSeq = seq;
    };
    const assertHandoffCurrent = () => {
        if(!('identity' in owner)){issuer.assertAdmissionCurrent();return}
        if(!sourceCapture||!sourceOutcome||sourceOutcome.kind!=='committed'||sourceSeq===undefined||!completion||!sourcePin||!sourceMember)throw new FactRecoveryRequiredError();
        source.assertHeld();sourcePin.assertCurrent();const members=sourcePin.members;if(members.length!==1||members[0]!==sourceMember)throw new FactRecoveryRequiredError();source.assertHeld();
    };    const settleHandoff = async () => {
        if (!wantsHandoff || handoffDone || handoffRefused || sourceRetired || unsupported)
            return;
        if (sourceSeq === undefined)
            throw new FactRecoveryRequiredError();
        handoff ??= source.delivery.capture({ type: 'agent/delivery-handoff', version: 1, kind: 'code', sourceSeq });
        const already = handoffAttempted;
        handoffAttempted = true;
        const outcome=await settleFact(handoff, already);
        if(isRetiredCodeHandoff(handoff,outcome)){handoffRefused=true;committedFactSeqs(outcome)}
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
            publishObservation();
            if (unsupported || sourceRetired || !sourceCapture)
                return;
            source.assertHeld();
            await drive();
            if (!completion)
                throw new FactRecoveryRequiredError();
            // Acknowledged background handoff retains the same original cell
            // until its finalization, without requesting the output source's
            // close while the Worker is still running. Stop/host close still
            // enter this original source drain and cancel the cell first.
            if (wantsHandoff && handoffDone)
                await waitOriginalCompletionFinalization(completion);
            const observed = await completion.settle();
            await settleHandoff();
            publishObservation();
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
        const flight = source.close().then(() => { sourcePin?.release();sourcePin=undefined;sourceMember=undefined;done = true; released(); });
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
        rememberObservation(publish:()=>void){if(retainedObservation||typeof publish!=='function')throw Error('Original Code observation already retained');retainedObservation=publish},
        async reconcileCapturedHandoff(){if(handoff&&!handoffDone&&!handoffRefused)await settleHandoff();},
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
            if(!sourceCapture||!sourceOutcome||sourceOutcome.kind!=='committed')throw new FactRecoveryRequiredError();
            if('identity' in owner){sourcePin=retainAcknowledgedExecutionMembers(sourceCapture,sourceOutcome);const members=sourcePin.members,event=members[0];if(members.length!==1||event?.type!=='agent/delivery-source'||event.kind!=='code'||event.seq!==sourceSeq||event.cellId!==cellId||event.sourceId!==sourceId)throw new FactRecoveryRequiredError();sourceMember=event}
            return {source,capture:sourceCapture,outcome:sourceOutcome};
        },
        async observed(running: boolean) {
            if (running && !unsupported) {
                assertHandoffCurrent();
                wantsHandoff = true;
                await settleHandoff();
                assertHandoffCurrent();
            }
            if (running) {
                retainedObservation=undefined;finish();
                return;
            }
            retainedObservation=undefined;returned.resolve();
            await settle();
            void close().catch(() => {
                try {
                    source.holdRecovery();
                }
                catch { /* Original owner keeps debt. */ }
            });
        },
        failed() { recoverObservation=true;finish(); }, close,
    });
}




