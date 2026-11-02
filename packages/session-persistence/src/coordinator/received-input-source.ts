import { validDeliveryEvent, isStrictFactData, type FactGroupDraft, type ReceivedInputSource } from '@i-harness/core-session';
import { captureSettlementFact, retainSettlementCapture,forwardSettlementCapture } from './settlement-fact.ts';
import { createSourceFacts } from './source-facts.ts';
import type { cancellationRetirementFor } from './received-input-cancellation.ts';
/** The trusted input composition acquires this before accepting requests. Its
 * captures join required settlement; new inference still needs an action. */
export function createReceivedInputSource(drain: () => Promise<void>, operations: Parameters<typeof captureSettlementFact>[1] & { cancellationRetirement: ReturnType<typeof cancellationRetirementFor>; owner:Readonly<import('@i-harness/core-session').OwnerToken>; deliveryControl:{revoke():()=>void}; guarded(check:()=>boolean):Parameters<typeof captureSettlementFact>[1] }, released: () => void): ReceivedInputSource<import('@i-harness/core-session').FactOutcome> & {
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
