import { validDeliveryEvent, isStrictFactData, committedFactSeqs, canonicalJsonData, type FactGroupDraft, type ReceivedInputSource, type FactOutcome } from '@i-harness/core-session';
import { captureSettlementFact, retainSettlementCapture,forwardSettlementCapture } from './settlement-fact.ts';
import { createSourceFacts } from './source-facts.ts';
import type { cancellationRetirementFor } from './received-input-cancellation.ts';
import {readAcknowledgedExecutionMembers,readManagedSourceAcknowledgedMembers,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
type TaskOpen = Readonly<{ document:object; view:import('@i-harness/core-session').SessionView|undefined; seq:number; event:object; eventData:string; binding:Readonly<{recipientSessionId:string;generationId:string;sourceNamespace:string;sourceId:string;callSeq:number}>;managed?:{source:ReceivedInputSource<FactOutcome>;capture:object;outcome:FactOutcome} }>
const taskOpens = new WeakMap<object,TaskOpen>()
export function inspectOriginalTaskDeliveryOpen(preparation:object, document:object) {
    const receipt=taskOpens.get(preparation)
    if(receipt && receipt.document!==document) throw new TypeError('Foreign task delivery preparation')
    return receipt
}
export function inspectManagedTaskDeliveryOpen(preparation:object,domain:ManagedExecutionDomain){
 const original=taskOpens.get(preparation),managed=original?.managed
 if(!original||!managed||original.document!==domain.owner)throw TypeError('Original managed Task open required')
 const members=readManagedSourceAcknowledgedMembers(domain,managed.source,managed.capture,managed.outcome)
 if(members.length!==1||members[0]!==original.event)throw TypeError('Original managed Task open changed')
 return Object.freeze({source:managed.source,capture:managed.capture,outcome:managed.outcome,members})
}
/** The trusted input composition acquires this before accepting requests. Its
 * captures join required settlement; new inference still needs an action. */
export function createReceivedInputSource(drain: () => Promise<void>, operations: Parameters<typeof captureSettlementFact>[1] & { document:object; view:import('@i-harness/core-session').SessionView|undefined; cancellationRetirement: ReturnType<typeof cancellationRetirementFor>; owner:Readonly<import('@i-harness/core-session').OwnerToken>; deliveryControl:{revoke():()=>void}; guarded(check:()=>boolean):Parameters<typeof captureSettlementFact>[1] }, released: () => void): ReceivedInputSource<import('@i-harness/core-session').FactOutcome> & {
    revoke(): void;
    assertHeld(): void;
} {
    let accepting = true, active = true, closing: Promise<void> | undefined;
    const assertHeld = () => {
        operations.assertHeld();
        if (!active)
            throw Object.assign(new Error('Received input source is closed'), { code: 'FACT_CLOSED' });
    };
    const records = createSourceFacts({ ...operations, assertHeld });
    const invalidDelivery = () => records.retain(retainSettlementCapture({kind:"not-issued",code:"FACT_INVALID_GROUP"},{...operations,assertHeld}));
    const retain = (draft: FactGroupDraft) => {
        assertHeld();
        let strict = false;
        try {
            strict = isStrictFactData(draft);
        }
        catch { /* Invalid DTO, never lower its hooks. */ }
        if (!strict)
            return records.retain(retainSettlementCapture({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' }, { ...operations, assertHeld }));
        return records.capture(draft, draft.kind === 'input-cancellation' ? operations.cancellationRetirement(draft.cancelled) : undefined);
    };
    const result: ReceivedInputSource<import("@i-harness/core-session").FactOutcome> & {assertHeld():void;revoke():void} = {
        assertHeld,
        captureDeliveryOpen(event,checkCurrent) { assertHeld();if(!validDeliveryEvent(event)||event.op!=="open")return invalidDelivery();if(!accepting)throw Object.assign(new Error("FACT_CLOSED"),{code:"FACT_CLOSED"});return records.capture({kind:"delivery-generation",event},undefined,{...operations.guarded(checkCurrent),assertHeld}); },
        captureTaskDeliveryOpen(event,checkCurrent,input) {
            assertHeld()
            const view=operations.view
            if(!isStrictFactData(input)||!input||typeof input!=='object')throw new TypeError('Invalid original task delivery binding')
            const fields=Object.getOwnPropertyDescriptors(input),keys=Reflect.ownKeys(fields)
            if(keys.length!==4||keys.some(key=>typeof key!=='string'||!['recipientSessionId','sourceNamespace','sourceId','callSeq'].includes(key))||Object.values(fields).some(field=>!field.enumerable||!('value' in field))||typeof input.recipientSessionId!=='string'||typeof input.sourceNamespace!=='string'||typeof input.sourceId!=='string'||!Number.isSafeInteger(input.callSeq)||input.callSeq<0)throw new TypeError('Invalid original task delivery binding')
            if(!accepting||!isStrictFactData(event)||!validDeliveryEvent(event)||event.op!=='open'||event.recipientSessionId!==input.recipientSessionId||operations.owner.sessionId!==input.recipientSessionId) throw new TypeError('Invalid original task delivery open')
            const binding=Object.freeze({recipientSessionId:input.recipientSessionId,sourceNamespace:input.sourceNamespace,sourceId:input.sourceId,callSeq:input.callSeq,generationId:event.generationId}),originInputSeq=event.originInputSeq, original=records.capture({kind:'delivery-generation',event},undefined,{...operations.guarded(checkCurrent),assertHeld})
            let outcome:FactOutcome|undefined,prepared:import('@i-harness/core-session').DeliveryLaunchPreparation|undefined
            const run=(method:keyof typeof original)=>async()=>{const result=await original[method]();outcome=result;return result}
            return {admit:run('admit'),observe:run('observe'),reconcile:run('reconcile'),retryAbsent:run('retryAbsent'),preparation(){
                assertHeld(); if(prepared)return prepared
                if(!outcome||outcome.kind!=='committed')throw new TypeError('Original delivery open is not acknowledged')
                const seqs=committedFactSeqs(outcome), seq=seqs[0],actual=seq===undefined?undefined:view?view.events[seq]:readAcknowledgedExecutionMembers(original,outcome)[0]
                if(seqs.length!==1||!actual||actual.type!=='agent/delivery-generation'||actual.op!=='open'||actual.recipientSessionId!==binding.recipientSessionId||actual.generationId!==binding.generationId||actual.originInputSeq!==originInputSeq)throw new TypeError('Original delivery open changed')
                prepared=Object.freeze({kind:'bound' as const,binding});taskOpens.set(prepared,Object.freeze({document:operations.document,view,seq:seq!,event:actual,eventData:canonicalJsonData(actual),binding,...!view?{managed:{source:result,capture:original,outcome}}:{}}));return prepared
            }}
        },
        captureDeliveryAdmission(receipt,admitted,checkCurrent) { assertHeld();if(!accepting)throw Object.assign(new Error("FACT_CLOSED"),{code:"FACT_CLOSED"});return records.capture({kind:"delivery-admission",receipt,admitted},undefined,{...operations.guarded(checkCurrent),assertHeld}); },
        captureDeliveryClose(event) {
            assertHeld();
            if(!validDeliveryEvent(event)||event.op!=="close")return invalidDelivery();
            const captured = captureSettlementFact({kind:"delivery-generation",event},{...operations,assertHeld});
            const confirmed=operations.deliveryControl.revoke();
            const run=(method:keyof typeof captured)=>async()=>{const outcome=await captured[method]();if(outcome.kind==="committed")confirmed();return outcome};
            return records.retain(forwardSettlementCapture(captured,{admit:run("admit"),observe:run("observe"),reconcile:run("reconcile"),retryAbsent:run("retryAbsent")}));
        },
        revoke() { accepting = false; },
        captureAdmitted(event) {
            assertHeld();
            if (!accepting)
                throw Object.assign(new Error('Received input source is closed'), { code: 'FACT_CLOSED' });
            return retain({ kind: 'input-admission', admitted: event });
        },
        captureCancellation(event) { return retain({ kind: 'input-cancellation', cancelled: event }); },
        close() {
            accepting = false;
            if (!active)
                return Promise.resolve();
            if (closing)
                return closing;
            const pending = Promise.resolve().then(records.drain).then(drain).then(records.drain).then(() => { active = false; released(); });
            closing = pending;
            void pending.catch(() => {
                if (closing === pending) closing = undefined;
            });
            return pending;
        },
    };
    Object.defineProperty(result,"owner",{value:operations.owner,writable:false,configurable:false,enumerable:true});
    return result;
}
