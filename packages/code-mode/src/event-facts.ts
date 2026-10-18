import { committedFactSeqs, FactRecoveryRequiredError, subscribe, type CapturedActionFact, type CodeSettlementFact, type FactOwner, type ManagedAction, type ProducerFactOutcome, type SessionEvent } from '@i-harness/core-session';
interface Pending {
    fact: CapturedActionFact<ProducerFactOutcome>;
    installed: boolean;
    action?: ManagedAction<ProducerFactOutcome>;
    onCommit?: () => void;
    onCancelled?: () => void;
    installationFailed?: true;
}
/** Mount-owned pending event sources contain only real, not-yet-settled facts.
 * Once a receipt and local installation succeed, their captures are released. */
export function createCodeModeEventFacts(owner: FactOwner, drainProducers: () => Promise<void>) {
    const pending = new Set<Pending>(), actions = new Map<string, ManagedAction<ProducerFactOutcome>>(), action = owner.beginAction();
    let serial = Promise.resolve();
    const commit = async (record: Pending, firstIssue = false) => {
        if (record.installationFailed)
            throw new FactRecoveryRequiredError();
        const outcome = await (firstIssue ? record.fact.admit() : record.fact.reconcile());
        if (record.action?.signal.aborted && (outcome.kind === 'absent' || outcome.kind === 'not-issued')) {
            pending.delete(record);
            record.onCancelled?.();
            return;
        }
        committedFactSeqs(outcome);
        if (!record.installed) {
            try {
                record.onCommit?.();
                record.installed = true;
            }
            catch (cause) {
                record.installationFailed = true;
                source.requireRecovery();
                throw Object.assign(new FactRecoveryRequiredError(), { cause });
            }
        }
        pending.delete(record);
    };
    const refresh = (): Promise<void> => {
        const settling = serial.then(async () => {
            do {
                const errors: unknown[] = [];
                for (const record of [...pending]) {
                    try {
                        await commit(record);
                    }
                    catch (error) {
                        errors.push(error);
                    }
                }
                if (errors.length)
                    throw Object.assign(new AggregateError(errors, 'Code Mode event settlement requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' });
            } while (pending.size);
        });
        serial = settling.catch(() => { });
        return settling;
    };
    const drain = async () => {
        // Unknown facts return before joining a producer whose continuation needs
        // that same receipt. Local callbacks may now schedule required settlement.
        await refresh();
        await drainProducers();
        await refresh();
    };
    const source = action.registerSettlementSource(drain);
    action.finish();
    const off = subscribe(owner.view, () => {
        if (pending.size)
            void refresh().catch(() => { });
    });
    return {
        refresh,
        requireRecovery() {
            source.requireRecovery();
        },
        captureReference(ref: Extract<SessionEvent, {
            type: 'context/result-ref';
        }>['ref']) {
            const record: Pending = { fact: source.retention.capture({ type: 'context/result-ref', ignorable: true, ref }), installed: false };
            pending.add(record);
            return async () => {
                if (!record.installed)
                    await commit(record);
            };
        },
        required(event: CodeSettlementFact, onCommit?: () => void) {
            const record: Pending = {
                fact: source.code.capture(event), installed: false, onCommit: () => {
                    onCommit?.();
                    if (event.type === 'code/cell') {
                        actions.get(event.cellId)?.finish();
                        actions.delete(event.cellId);
                    }
                }
            };
            pending.add(record);
            return commit(record);
        },
        async optional(event: Extract<SessionEvent, {
            type: 'code/cell';
        }>, signal?: AbortSignal) {
            const action = owner.beginAction(signal);
            actions.set(event.cellId, action);
            committedFactSeqs(await action.facts.code.record(event));
        },
        async store(event: Extract<SessionEvent, {
            type: 'code/store';
        }>, onCommit: () => void, onCancelled: () => void) {
            const action = actions.get(event.cellId);
            if (!action)
                throw new FactRecoveryRequiredError();
            const record: Pending = { fact: action.captureCodeStore(event), action, installed: false, onCommit, onCancelled };
            pending.add(record);
            await commit(record, true);
        },
        stopOptional() {
            for (const action of actions.values())
                action.stop();
        },
        assertObserved() {
            if (pending.size)
                throw new FactRecoveryRequiredError();
        },
        async close() {
            await source.close();
            off();
        },
    };
}
