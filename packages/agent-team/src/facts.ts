import { AsyncLocalStorage } from 'node:async_hooks';
import { committedFactSeqs, createNondurableFactOwner, isManagedFactOwner, isNondurableSession, type CapturedActionFact, type CapturedSettlementFact, type FactOwner, type ManagedAction, type ProducerFactOutcome, type SessionEvent, type SessionView } from '@i-harness/core-session';
import type { TeamEvent } from './types.ts';
export function teamFactOwner(view: SessionView, supplied?: FactOwner): FactOwner {
    const owner = supplied ?? (isNondurableSession(view) ? createNondurableFactOwner(view) : undefined);
    if (!owner || owner.view !== view || !isNondurableSession(view) && !isManagedFactOwner(view, owner))
        throw Object.assign(new Error('Team requires its actual document owner'), { code: 'FACT_OWNER_UNSUPPORTED' });
    return owner;
}
/** Tool cancellation context is scheduling data, never a write capability. */
export function createTeamFacts(owner: FactOwner, drainTransactions: () => Promise<void>, committed: () => void) {
    const signals = new AsyncLocalStorage<{
        signal?: AbortSignal;
    }>();
    const transactions = new Map<readonly TeamEvent[], {
        action: ManagedAction<ProducerFactOutcome>;
        fact: CapturedActionFact<ProducerFactOutcome>;
    }>();
    const action = owner.beginAction(), source = action.registerSettlementSource(drainTransactions);
    action.finish();
    return {
        run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> { return signals.run({ signal }, work); },
        async commit(events: readonly TeamEvent[]) {
            let pending = transactions.get(events);
            const existing = !!pending;
            if (!pending) {
                const action = owner.beginAction(signals.getStore()?.signal);
                pending = { action, fact: action.captureTeamTransaction(events) };
                transactions.set(events, pending);
            }
            const outcome = await (existing ? pending.fact.reconcile() : pending.fact.admit());
            if (pending.action.signal.aborted && (outcome.kind === 'absent' || outcome.kind === 'not-issued')) {
                pending.action.finish();
                transactions.delete(events);
                throw Object.assign(new Error('Team transaction cancelled before commitment'), { code: 'FACT_CANCELLED' });
            }
            committedFactSeqs(outcome);
            pending.action.finish();
            transactions.delete(events);
        },
        onCommit: committed,
        close: () => source.close(),
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
