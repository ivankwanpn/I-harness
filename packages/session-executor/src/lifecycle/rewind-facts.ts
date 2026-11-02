import { committedFactSeqs, type CapturedSettlementFact, type FactOwner, type ProducerFactOutcome, type SessionEvent } from '@i-harness/core-session';
import { receivedInputsFor } from './received-inputs.ts';
import {isManagedExecutionDomain,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution';
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../../session-persistence/src/execution-internal.ts';
import {receivedExecutionInputsFor,isOriginalPrivateExecRecipient} from './execution-inputs.ts';
/** Register before file restoration. A marker failure retains this original
 * source; document drain settles its fact without restoring files again. */
export async function withRewindFacts<T>(owner: FactOwner, restore: (append: (event: Extract<SessionEvent, {
    type: 'rewind/point';
}>) => Promise<void>) => Promise<T>): Promise<T> {
    // The cached received source owns both the synchronous fence and its
    // original durable close. No restoration action/effect starts on debt.
    await receivedInputsFor(owner).delivery.requestClose('rewind').settled;
    const action = owner.beginAction(), finished = Promise.withResolvers<void>();
    let fact: CapturedSettlementFact<ProducerFactOutcome> | undefined;
    const settle = async () => {
        if (fact) committedFactSeqs(await fact.reconcile());
    };
    const source = action.registerSettlementSource(async () => { await finished.promise; await settle(); });
    let primary: unknown, failed = false;
    try {
        action.assertOpen();
        return await restore(async (event) => {
            if (fact) throw new Error('Rewind marker source was already captured');
            fact = source.rewind.capture(event);
            await settle();
        });
    }
    catch (error) {
        primary = error;
        failed = true;
        throw error;
    }
    finally {
        action.finish();
        finished.resolve();
        try { await source.close(); }
        catch (cleanup) {
            if (failed) throw new AggregateError([primary, cleanup], 'Rewind restoration and marker settlement failed', { cause: primary });
            throw cleanup;
        }
    }
}

/** The private writer's own recipient fences delivery before the original
 * action registers its required marker settlement source. */
export async function withManagedRewindFacts<T>(execution:ManagedExecutionAttachment,domain:ManagedExecutionDomain,restore:(append:(event:Extract<SessionEvent,{type:'rewind/point'}>)=>Promise<void>)=>Promise<T>):Promise<T>{
    if(!isManagedExecutionAttachment(execution)||!isManagedExecutionDomain(domain)||domain.identity!==execution.identity||domain.owner!==execution.owner)throw TypeError('Original managed Rewind execution required');
    const recipient=receivedExecutionInputsFor(execution).execDelivery(domain);
    if(!isOriginalPrivateExecRecipient(recipient,execution,domain))throw TypeError('Original managed Rewind recipient required');
    await recipient.requestClose('rewind').settled;
    const action=execution.owner.beginAction(),finished=Promise.withResolvers<void>();
    let fact:CapturedSettlementFact<ProducerFactOutcome>|undefined;
    const settle=async()=>{if(fact)committedFactSeqs(await fact.reconcile())};
    const source=action.registerSettlementSource(async()=>{await finished.promise;await settle()});
    let primary:unknown,failed=false;
    try{action.assertOpen();return await restore(async event=>{if(fact)throw Error('Rewind marker source was already captured');fact=source.rewind.capture(event);await settle()})}
    catch(error){primary=error;failed=true;throw error}
    finally{action.finish();finished.resolve();try{await source.close()}catch(cleanup){if(failed)throw new AggregateError([primary,cleanup],'Rewind restoration and marker settlement failed',{cause:primary});throw cleanup}}
}
