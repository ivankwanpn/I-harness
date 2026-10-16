import { isStrictFactData, type FactGroupDraft, type ReceivedInputSource } from '@i-harness/core-session';
import { captureSettlementFact, retainSettlementCapture } from './settlement-fact.ts';
import { createSourceFacts } from './source-facts.ts';
/** The trusted input composition acquires this before accepting requests. Its
 * captures join required settlement; new inference still needs an action. */
export function createReceivedInputSource(drain: () => Promise<void>, operations: Parameters<typeof captureSettlementFact>[1], released: () => void): ReceivedInputSource<import('@i-harness/core-session').FactOutcome> & {
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
    const retain = (draft: FactGroupDraft) => {
        assertHeld();
        let strict = false;
        try {
            strict = isStrictFactData(draft);
        }
        catch { /* Invalid DTO, never lower its hooks. */ }
        if (!strict)
            return records.retain(retainSettlementCapture({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' }, { ...operations, assertHeld }));
        return records.capture(draft);
    };
    return {
        assertHeld,
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
}
