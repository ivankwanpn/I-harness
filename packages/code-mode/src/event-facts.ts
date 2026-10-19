import { captureLegacyFact, isStrictFactData, committedFactSeqs, FactRecoveryRequiredError, subscribe, type CapturedActionFact, type CodeSettlementFact, type FactOwner, type ManagedAction, type ProducerFactOutcome, type SessionEvent, type SettlementFacts } from '@i-harness/core-session';
interface Pending {
    fact?: CapturedActionFact<ProducerFactOutcome>;
    prepare?: () => Promise<CodeSettlementFact>;
    source?: SettlementFacts<ProducerFactOutcome>;
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
    const outputs = new Map<string, { source: SettlementFacts<ProducerFactOutcome>; records: Pending[] }>();
    let serial = Promise.resolve();
    const commit = async (record: Pending, firstIssue = false) => {
        if (record.installationFailed)
            throw new FactRecoveryRequiredError();
        if (!record.fact) {
            try { record.fact = (record.source ?? source).code.capture(await record.prepare!()); record.prepare = undefined; }
            catch (cause) { (record.source ?? source).holdRecovery(); throw Object.assign(new FactRecoveryRequiredError(), { cause }); }
        }
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
                        if (record.source) {
                            await record.source.close();
                            for (const [cellId, group] of outputs) if (group.source === record.source) outputs.delete(cellId);
                        }
                        else await commit(record);
                    }
                    catch (error) {
                        errors.push(error);
                        // Later original outputs cannot pass an unresolved earlier
                        // output's storage/publication boundary.
                        break;
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
        assertHeld() { source.assertHeld(); },
        /** Register original accepted work before its first storage await. The
         * same record owns preparation and exactly one eventual F1 capture. */
        requiredPrepared(cellId: string, prepare: (assertHeld: () => void) => Promise<CodeSettlementFact>, onCommit?: () => void) {
            let group = outputs.get(cellId);
            if (!group) {
                const cellAction = actions.get(cellId);
                if (!cellAction) throw new FactRecoveryRequiredError();
                const records: Pending[] = [];
                const outputSource = cellAction.registerSettlementSource(async () => {
                    for (let index = 0; index < records.length; index++) if (!records[index]!.installed) await commit(records[index]!);
                });
                group = { source: outputSource, records }; outputs.set(cellId, group);
            }
            // Already accepted backlog belongs to the same original source.
            // Recovery must not allocate new authority under its own hold.
            const outputSource = group.source;
            const record: Pending = { prepare: () => prepare(outputSource.assertHeld), source: outputSource, installed: false, onCommit };
            group.records.push(record);
            pending.add(record);
            return refresh();
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
            if (!isStrictFactData(event)) { source.requireRecovery(); throw new FactRecoveryRequiredError(); }
            const original = captureLegacyFact(event);
            if (original.kind !== 'captured') { source.requireRecovery(); throw new FactRecoveryRequiredError(); }
            const captured = original.value;
            const record: Pending = {
                // Freeze metadata now; allocate its F1 capture only at the
                // ordered queue position. Source pre-drain must not issue a
                // terminal ahead of an earlier unknown output artifact.
                prepare: async () => captured, installed: false, onCommit: () => {
                    onCommit?.();
                    if (captured.type === 'code/cell') {
                        actions.get(captured.cellId)?.finish();
                        actions.delete(captured.cellId);
                    }
                }
            };
            pending.add(record);
            // Terminal publication cannot overtake an accepted output whose
            // original storage/F1 stage is still pending, including human Stop.
            return refresh();
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
