import { committedFactSeqs, type CapturedSettlementFact, type FactOwner, type ProducerFactOutcome, type SessionEvent } from '@i-harness/core-session';
/** Register before file restoration. A marker failure retains this original
 * source; document drain settles its fact without restoring files again. */
export async function withRewindFacts<T>(owner: FactOwner, restore: (append: (event: Extract<SessionEvent, {
    type: 'rewind/point';
}>) => Promise<void>) => Promise<T>): Promise<T> {
    const action = owner.beginAction(), finished = Promise.withResolvers<void>();
    let fact: CapturedSettlementFact<ProducerFactOutcome> | undefined;
    const settle = async () => {
        if (fact) committedFactSeqs(await fact.reconcile());
    };
    const source = action.registerSettlementSource(async () => { await finished.promise; await settle(); });
    try {
        action.assertOpen();
        return await restore(async (event) => {
            if (fact) throw new Error('Rewind marker source was already captured');
            fact = source.rewind.capture(event);
            await settle();
        });
    }
    finally {
        action.finish();
        finished.resolve();
        await source.close();
    }
}
