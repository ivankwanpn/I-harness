import type { CodeModeRuntimeOptions, CodeModeRuntimeEvent } from '../types.js';
import type { Cell, CellState } from './cell-state.js';
import type { CodeModeStatus, CodeModeStoreEntries } from '../types.js';
import { diagnostic, message } from './limits.js';
/** Sole stop, commit queue, cancellation barrier, and disposal authority. */
export function createRetirement(options: CodeModeRuntimeOptions, errorCap: number, state: Pick<CellState, 'entries' | 'currentStore' | 'track' | 'installStore' | 'values' | 'drain' | 'clear'>, event: (event: CodeModeRuntimeEvent) => void | Promise<void>, cancelRuntime: (reason: string) => Promise<void>) {
    const { entries, currentStore, track } = state;
    const stopping = new Set<Promise<number>>();
    let commits: Promise<void> = Promise.resolve();
    let disposed = false;
    let disposing: Promise<void> | undefined;
    let cancelling: Promise<void> | undefined;
    let cancellationEpoch = 0;
    function stop(cell: Cell) {
        if (cell.stop)
            return cell.stop;
        const pending = cell.worker.terminate();
        cell.stop = pending;
        stopping.add(pending);
        void pending.finally(() => stopping.delete(pending));
        return pending;
    }
    function close(cell: Cell, status: Exclude<CodeModeStatus, 'running'>, error?: string, policyRefusal?: true) {
        if (cell.status !== 'running')
            return;
        // Once a real completion was handed to its source, Stop/storage cleanup
        // cannot overwrite it with a fabricated failed/terminated outcome.
        if (cell.finishing && cell.completionPending && cell.completionRetained) {
            cell.stopRequested = error ?? 'Code Mode cancelled';
            cell.commitStop.abort(cell.stopRequested);
            return;
        }
        const bounded = error === undefined ? undefined : diagnostic(error, errorCap);
        cell.status = status;
        cell.error = bounded?.text;
        cell.truncated ||= bounded?.truncated ?? false;
        cell.policyRefusal = policyRefusal;
        cell.commitStop.abort(cell.error ?? 'Cell closed');
        if (status === 'terminated')
            cell.retentionStop.abort(cell.error ?? 'Cell stopped');
        clearTimeout(cell.watchdog);
        cell.removeOwner?.();
        for (const controller of cell.calls.values())
            controller.abort(cell.error ?? 'Cell completed');
        cell.calls.clear();
        void stop(cell);
        function failed(failure: unknown) {
            if (String((failure as {
                code?: string;
            })?.code ?? '').startsWith('FACT_')) {
                cell.recoveryRequired = true;
                cell.wake?.();
                return;
            }
            if (cell.status !== 'terminated')
                cell.status = 'failed';
            const failed = diagnostic(failure, errorCap);
            const combined = diagnostic(cell.error ? `${cell.error}; ${failed.text}` : failed.text, errorCap);
            cell.error = combined.text;
            cell.truncated ||= failed.truncated || combined.truncated;
        }
        try {
            const committed = () => {
                cell.terminalReceiptPending = false;
                cell.recoveryRequired = false;
                cell.wake?.();
            };
            const pending = event({
                type: 'closed', cellId: cell.id, status, error: cell.error, policyRefusal, origin: cell.origin, committed, retainOutcome() {
                    cell.terminalReceiptPending = true;
                }
            });
            if (pending)
                track(Promise.resolve(pending).catch(failed).finally(() => cell.wake?.()), cell);
            else
                committed();
        }
        catch (failure) {
            failed(failure);
        }
        finally {
            cell.wake?.();
        }
    }
    function complete(cell: Cell, encoded: string) {
        cell.finishing = true;
        clearTimeout(cell.watchdog);
        // Executable lifetime ends when the guest module ends. Persistence retains
        // only JSON and never extends unawaited tools, timers or continuations.
        for (const controller of cell.calls.values())
            controller.abort('Guest module completed');
        cell.calls.clear();
        void stop(cell);
        let writes: CodeModeStoreEntries;
        try {
            writes = entries(JSON.parse(encoded));
        }
        catch (error) {
            close(cell, 'failed', message(error));
            return;
        }
        cell.completionPending = true;
        let storeRequested = false, storeCommitted = false, terminalStarted = false, running = false, resume = false;
        const recovery = () => {
            cell.recoveryRequired = true;
            cell.error = 'Code Mode completion requires fact reconciliation';
            cell.wake?.();
        };
        const cancelled = () => {
            if (storeCommitted || terminalStarted || cell.status !== 'running')
                return;
            cell.finishing = false;
            cell.completionPending = false;
            cell.completionRetained = false;
            cell.recoveryRequired = false;
            close(cell, 'terminated', cell.stopRequested ?? 'Code Mode store commit cancelled');
        };
        const terminal = () => {
            if (terminalStarted || cell.status !== 'running')
                return;
            // The callback observes only committed store data and may publish the
            // already-computed true terminal. It cannot restart executable work.
            const merged = currentStore(cell.origin);
            for (const [key, value] of writes)
                merged.set(key, value);
            const bounded = entries([...merged]);
            terminalStarted = true;
            let installed = false;
            const committed = () => {
                if (installed)
                    return;
                if (!cell.completionRetained && cell.status !== 'running')
                    return;
                if (writes.length)
                    state.installStore(bounded);
                cell.status = 'completed';
                cell.recoveryRequired = false;
                cell.terminalReceiptPending = false;
                cell.error = undefined;
                cell.removeOwner?.();
                cell.wake?.();
                cell.resumeCompletion = undefined;
                installed = true;
            };
            const pending = (async () => {
                try {
                    await event({
                        type: 'closed', cellId: cell.id, status: 'completed', origin: cell.origin, committed, retainOutcome() {
                            cell.completionRetained = true;
                            cell.terminalReceiptPending = true;
                        }
                    });
                    committed();
                }
                catch (error) {
                    if (String((error as {
                        code?: string;
                    })?.code ?? '').startsWith('FACT_'))
                        recovery();
                    else {
                        cell.finishing = false;
                        cell.completionPending = false;
                        close(cell, 'failed', message(error));
                    }
                }
            })();
            track(pending, cell);
        };
        const committedStore = () => {
            if (storeCommitted || cell.status !== 'running')
                return;
            storeCommitted = true;
            terminal();
        };
        const finalize = async () => {
            try {
                await cell.admission;
                if (cell.status !== 'running')
                    return;
                if (cell.pendingOutputReceipts) {
                    recovery();
                    return;
                }
                if (!writes.length) {
                    terminal();
                    return;
                }
                if (!storeRequested) {
                    if (cell.commitStop.signal.aborted) {
                        cancelled();
                        return;
                    }
                    const merged = currentStore(cell.origin);
                    for (const [key, value] of writes)
                        merged.set(key, value);
                    entries([...merged]);
                    storeRequested = true;
                    await options.commitStore?.({
                        cellId: cell.id, origin: cell.origin, writes, signal: cell.commitStop.signal, committed: committedStore, cancelled, retainOutcome() {
                            cell.completionRetained = true;
                        }
                    });
                    committedStore();
                }
            }
            catch (error) {
                if (String((error as {
                    code?: string;
                })?.code ?? '').startsWith('FACT_'))
                    recovery();
                else if (cell.commitStop.signal.aborted)
                    cancelled();
                else {
                    cell.finishing = false;
                    cell.completionPending = false;
                    close(cell, 'failed', message(error));
                }
            }
        };
        const schedule = () => {
            if (running) {
                resume = true;
                return Promise.resolve();
            }
            running = true;
            const pending = finalize().finally(() => {
                running = false;
                if (resume) {
                    resume = false;
                    schedule();
                }
            });
            track(pending, cell);
            return pending;
        };
        cell.resumeCompletion = () => {
            void schedule();
        };
        // Read-only completions do not queue behind a held store write. Every write
        // merges and validates only when earlier durable commits have settled.
        if (writes.length) {
            const pending = commits.then(schedule);
            commits = pending.then(() => { }, () => { });
            track(pending, cell);
        }
        else
            void schedule();
    }
    async function cancel(reason = 'Code Mode cancelled') {
        if (cancelling)
            return cancelling;
        // Start the admission barrier before calling any event/abort listeners.
        let finish!: () => void;
        const barrier = new Promise<void>(resolve => {
            finish = resolve;
        });
        cancelling = barrier;
        cancellationEpoch++;
        for (const cell of state.values()) {
            cell.retentionStop.abort(reason);
            close(cell, 'terminated', reason);
        }
        try {
            await Promise.allSettled([...stopping]);
            await state.drain();
        }
        finally {
            cancelling = undefined;
            finish();
        }
    }
    async function dispose() {
        if (!disposing) {
            disposed = true;
            disposing = cancelRuntime('Code Mode disposed').then(() => {
                state.clear();
            });
        }
        return disposing;
    }
    return {
        stop, close, complete, cancel, dispose,
        isDisposed: () => disposed, isCancelling: () => cancelling, epoch: () => cancellationEpoch,
    };
}
export type Retirement = ReturnType<typeof createRetirement>;
