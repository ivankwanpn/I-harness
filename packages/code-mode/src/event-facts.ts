import { captureLegacyFact, isStrictFactData, committedFactSeqs, FactRecoveryRequiredError, subscribe, type CapturedActionFact, type CodeSettlementFact, type FactOwner, type ManagedAction, type ProducerFactOutcome, type SessionEvent, type SettlementFacts } from '@i-harness/core-session';
interface Pending {
    fact?: CapturedActionFact<ProducerFactOutcome>;
    prepare?: () => Promise<CodeSettlementFact>;
    source?: SettlementFacts<ProducerFactOutcome>;
    installed: boolean;
    action?: ManagedAction<ProducerFactOutcome>;
    onCommit?: () => void;
    onCancelled?: () => void;
    onSettled?: () => void;
    installationFailed?: true;
}
/** Mount-owned pending event sources contain only real, not-yet-settled facts.
 * Once a receipt and local installation succeed, their captures are released. */
export function createCodeModeEventFacts(owner: FactOwner, drainProducers: () => Promise<void>, onObservationChange?: () => void) {
    const pending = new Set<Pending>(), actions = new Map<string, ManagedAction<ProducerFactOutcome>>(), action = owner.beginAction();
    const outputs = new Map<string, { source: SettlementFacts<ProducerFactOutcome>; records: Pending[] }>();
    const recoveryHolds = new Set<SettlementFacts<ProducerFactOutcome>>();
    const admissionHolds = new Map<string, object>();
    let retired = false, stickyRecovery = false, admitting = 0, cancelling = 0;
    const changed = () => { try { onObservationChange?.(); } catch { /* Observation cannot fail the original producer. */ } };
    const requireRecovery = () => { stickyRecovery = true; changed(); source.requireRecovery(); };
    const observationState = (): 'available' | 'unavailable' | 'retired' => retired ? 'retired'
        : stickyRecovery || admitting || cancelling || pending.size || recoveryHolds.size || admissionHolds.size ? 'unavailable' : 'available';
    let serial = Promise.resolve();
    const commit = async (record: Pending, firstIssue = false) => {
        if (record.installationFailed)
            throw new FactRecoveryRequiredError();
        if (!record.fact) {
            try { record.fact = (record.source ?? source).code.capture(await record.prepare!()); record.prepare = undefined; }
            catch (cause) {
                const held = record.source ?? source;
                recoveryHolds.add(held); changed(); held.holdRecovery();
                throw Object.assign(new FactRecoveryRequiredError(), { cause });
            }
        }
        const outcome = await (firstIssue ? record.fact.admit() : record.fact.reconcile());
        if (record.action?.signal.aborted && (outcome.kind === 'absent' || outcome.kind === 'not-issued')) {
            cancelling++;
            pending.delete(record);
            try { record.onCancelled?.(); }
            catch (error) { stickyRecovery = true; throw error; }
            finally { cancelling--; changed(); }
            return;
        }
        committedFactSeqs(outcome);
        if (!record.installed) {
            try {
                record.onCommit?.();
                record.installed = true;
                changed();
            }
            catch (cause) {
                record.installationFailed = true;
                requireRecovery();
                throw Object.assign(new FactRecoveryRequiredError(), { cause });
            }
        }
        pending.delete(record);
        record.onSettled?.();
        changed();
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
                            recoveryHolds.delete(record.source);
                            changed();
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
        observationState,
        requireRecovery,
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
            changed();
            return refresh();
        },
        captureReference(ref: Extract<SessionEvent, {
            type: 'context/result-ref';
        }>['ref']) {
            const record: Pending = { fact: source.retention.capture({ type: 'context/result-ref', ignorable: true, ref }), installed: false };
            pending.add(record);
            changed();
            return async () => {
                if (!record.installed)
                    await commit(record);
            };
        },
        required(event: CodeSettlementFact, onCommit?: () => void) {
            if (!isStrictFactData(event)) { requireRecovery(); throw new FactRecoveryRequiredError(); }
            const original = captureLegacyFact(event);
            if (original.kind !== 'captured') { requireRecovery(); throw new FactRecoveryRequiredError(); }
            const captured = original.value;
            // Only this rejected start's original interrupted record can
            // release its observation hold, after installation AND deletion.
            const admission = captured.type === 'code/cell' && captured.state === 'interrupted' ? admissionHolds.get(captured.cellId) : undefined;
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
                },
                onSettled: admission ? () => {
                    if (captured.type === 'code/cell' && admissionHolds.get(captured.cellId) === admission) admissionHolds.delete(captured.cellId);
                } : undefined
            };
            pending.add(record);
            changed();
            // Terminal publication cannot overtake an accepted output whose
            // original storage/F1 stage is still pending, including human Stop.
            return refresh();
        },
        async optional(event: Extract<SessionEvent, {
            type: 'code/cell';
        }>, signal?: AbortSignal) {
            admitting++; changed();
            const admission = {};
            try {
                const action = owner.beginAction(signal);
                actions.set(event.cellId, action);
                committedFactSeqs(await action.facts.code.record(event));
            } catch (error) {
                admissionHolds.set(event.cellId, admission);
                throw error;
            } finally { admitting--; changed(); }
        },
        async store(event: Extract<SessionEvent, {
            type: 'code/store';
        }>, onCommit: () => void, onCancelled: () => void) {
            const action = actions.get(event.cellId);
            if (!action)
                throw new FactRecoveryRequiredError();
            const record: Pending = { fact: action.captureCodeStore(event), action, installed: false, onCommit, onCancelled };
            pending.add(record);
            changed();
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
            if (!retired) { retired = true; changed(); }
            await source.close();
            off();
        },
    };
}
