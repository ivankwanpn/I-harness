import { committedFactSeqs, createNondurableFactOwner, isNondurableSession, type CapturedSettlementFact, type FactOwner, type ProducerFactOutcome, type SessionView } from '@i-harness/core-session';
import type { ContextResultRef } from '@i-harness/context-output';
/** Composition-owned reference publication for an actual tool/cell callback.
 * Each document keeps its own original capture and disposition through close. */
export function createResultReferencePublisher(view: SessionView, owner?: FactOwner) {
    if (!owner && isNondurableSession(view))
        owner = createNondurableFactOwner(view);
    if (!owner || owner.view !== view)
        throw Object.assign(new Error('Result reference requires its exact document owner'), { code: 'FACT_OWNER_UNSUPPORTED' });
    const pending = new Set<CapturedSettlementFact<ProducerFactOutcome>>();
    const action = owner.beginAction();
    const settle = async (fact: CapturedSettlementFact<ProducerFactOutcome>) => {
        if (!pending.has(fact))
            return;
        committedFactSeqs(await fact.reconcile());
        pending.delete(fact);
    };
    const source = action.registerSettlementSource(async () => {
        const errors: unknown[] = [];
        for (const fact of pending)
            try {
                await settle(fact);
            }
            catch (error) {
                errors.push(error);
            }
        if (errors.length)
            throw Object.assign(new AggregateError(errors, 'Result reference publication requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' });
    });
    action.finish();
    return (ref: ContextResultRef) => {
        const fact = source.retention.capture({ type: 'context/result-ref', ignorable: true, ref });
        pending.add(fact);
        return () => settle(fact);
    };
}
