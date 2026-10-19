import type { CodeModeRuntimeOptions, CodeModeRuntimeEvent } from '../types.js';
import type { RuntimeLimits } from './limits.js';
import type { Cell, CellState } from './cell-state.js';
import { validateImage } from '@i-harness/image-validation';
import { waitForObservation } from '@i-harness/core-tools';
import type { CodeModeItem, CodeModeObservation, CodeModeObserveOptions, CodeModeTextRetention, CodeModeTextRetentionResult } from '../types.js';
import type { Retirement } from './retirement.js';
import { FactRecoveryRequiredError } from '@i-harness/core-session';
import { TEXT_CAP, ITEM_CAP, message, textSlice } from './limits.js';

/** Map one host retention disposition onto the bounded model/archive descriptor.
 * Only a verified artifact makes `stored` true; everything else is explicit. */
function applyTextRetention(target: CodeModeTextRetention, retained: CodeModeTextRetentionResult, incomplete: boolean): void {
    if (retained.kind === 'unavailable') { target.stored = false; target.unavailable = retained.reason; return }
    if (retained.kind === 'recovery-required') { target.stored = false; target.unavailable = 'storage-unknown'; return }
    const retention = retained.envelope.retention
    if (retention.kind === 'artifact') {
        target.stored = true; target.complete = retention.ref.completeness === 'complete' && !incomplete; target.envelope = retained.envelope; delete target.unavailable; return
    }
    // An inline value would carry the whole text again; never treat it as an archive.
    target.stored = false; target.unavailable = retention.kind === 'unavailable' ? retention.reason : 'unsupported-owner'
}
/** Admission barrier and the sole observer/output-window lifetime. Complete
 * emitted text is retained by the host's result store; this module never
 * writes a spill file and never re-inlines the huge text. */
export function createOutput(options: CodeModeRuntimeOptions, config: RuntimeLimits, state: Pick<CellState, 'track' | 'retire'>, retirement: Pick<Retirement, 'close'>, event: (event: CodeModeRuntimeEvent) => void | Promise<void>) {
    const { track } = state;
    const { close } = retirement;
    const capturedText = new WeakMap<CodeModeItem, CodeModeTextRetentionResult>();
    function output(cell: Cell, encoded: string) {
        if (cell.status !== 'running')
            return;
        const item = JSON.parse(encoded) as CodeModeItem;
        const bytes = Buffer.byteLength(encoded);
        if (cell.items.length + cell.pendingItems + cell.retainedOutputItems >= ITEM_CAP || cell.bytes + cell.pendingBytes + cell.retainedOutputBytes + bytes > config.maxResultBytes) {
            cell.truncated = true;
            cell.textIncomplete ||= item.type === 'text';
            return;
        }
        // Reserve before asynchronous decoding. All following output shares the same
        // order, and completion waits for this barrier before committing any store.
        cell.pendingBytes += bytes;
        cell.pendingItems++;
        let installed = false, retained = false;
        cell.admission = cell.admission.then(async () => {
            if (cell.status !== 'running')
                return;
            if (item.type === 'image')
                await validateImage(item.image, { signal: cell.commitStop.signal });
            if (cell.status !== 'running')
                return;
            cell.pendingOutputReceipts++;
            const committed = (captured?: CodeModeTextRetentionResult) => {
                if (installed)
                    return;
                if (captured) capturedText.set(item, captured);
                cell.items.push(item);
                cell.bytes += bytes;
                if (item.type === 'text')
                    cell.textBytes += Buffer.byteLength(item.text);
                cell.pendingOutputReceipts--;
                installed = true;
                if (retained) {
                    cell.retainedOutputBytes -= bytes;
                    cell.retainedOutputItems--;
                    retained = false;
                }
                if (!cell.pendingOutputReceipts && !cell.terminalReceiptPending) {
                    cell.recoveryRequired = false;
                    cell.error = undefined;
                    cell.resumeCompletion?.();
                }
                cell.wake?.();
            };
            await event({
                type: 'output', cellId: cell.id, item, origin: cell.origin, committed, retainOutcome() {
                    cell.completionRetained = true;
                }
            });
            committed();
        }).catch(error => {
            if (String((error as {
                code?: string;
            })?.code ?? '').startsWith('FACT_')) {
                if (!installed) {
                    retained = true;
                    cell.retainedOutputBytes += bytes;
                    cell.retainedOutputItems++;
                    cell.recoveryRequired = true;
                    cell.error = 'Code Mode output requires fact reconciliation';
                    cell.wake?.();
                }
            }
            else if (cell.status === 'running')
                close(cell, 'failed', message(error));
        }).finally(() => {
            cell.pendingBytes -= bytes;
            cell.pendingItems--;
        });
        track(cell.admission, cell);
    }
    async function project(cell: Cell, tokens: number, steered: boolean, signal?: AbortSignal, passive = false): Promise<CodeModeObservation> {
        const admitted = cell.items;
        const incomplete = cell.textIncomplete;
        let truncated = cell.truncated;
        // Detach the consumed window before awaiting disk I/O. Later guest output
        // stays queued for the next observer rather than disappearing on reset.
        cell.items = [];
        cell.bytes = 0;
        cell.textBytes = 0;
        cell.truncated = false;
        cell.textIncomplete = false;
        cell.yielded = false;
        const textItems = admitted.filter((item): item is Extract<CodeModeItem, {
            type: 'text';
        }> => item.type === 'text');
        const captured = textItems.length > 0 && textItems.every(item => capturedText.has(item));
        // Shipping mounts already captured each original item before its F1
        // receipt. Only standalone runtimes without an event owner use the
        // legacy observer-time port; never join/re-store shipping text bodies.
        const fullText = captured ? '' : textItems.map(item => item.text).join('\n');
        const admittedBytes = textItems.reduce((total, item) => total + Buffer.byteLength(item.text), Math.max(0, textItems.length - 1));
        let textRetention: CodeModeTextRetention | undefined;
        let continueRetention: (() => Promise<CodeModeTextRetentionResult>) | undefined;
        const previewBytes = Math.min(TEXT_CAP, tokens * 4);
        const diagnosticBytes = cell.error === undefined ? 0 : Buffer.byteLength(textSlice(cell.error, previewBytes));
        if (admittedBytes > previewBytes - diagnosticBytes || incomplete || captured) {
            textRetention = { stored: false, cellId: cell.id, ...(cell.origin.sessionId ? { sessionId: cell.origin.sessionId } : {}), admittedBytes, omittedBytes: 0, complete: false, truncated: admittedBytes > previewBytes - diagnosticBytes || incomplete, representation: captured && textItems.length > 1 ? 'code-text-index-v1' : 'text' };
            if ((fullText || captured) && (!passive || captured)) {
                try {
                    const retaining = (async (): Promise<CodeModeTextRetentionResult> => {
                        if (captured) {
                            const results = textItems.map(item => capturedText.get(item)!);
                            const unavailable = results.find(result => result.kind !== 'ready');
                            if (unavailable) return unavailable;
                            if (results.length === 1) return results[0]!;
                        }
                        const retentionSignal = AbortSignal.any([cell.retentionStop.signal, ...(cell.origin.abortSignal ? [cell.origin.abortSignal] : []), ...(signal ? [signal] : [])]);
                        if (!captured) retentionSignal.throwIfAborted();
                        // No host owner means no durable result. There is deliberately no
                        // spill fallback: an untracked temp file is not a saved result.
                        if (!options.retainText)
                            return { kind: 'unavailable', reason: 'no-owner' };
                        const retained = await options.retainText({
                            text: fullText, cellId: cell.id, origin: { ...cell.origin, abortSignal: retentionSignal }, complete: !incomplete, status: cell.status, retainOutcome(settle) {
                                continueRetention = settle;
                            }, ...(captured ? { index: { version: 1 as const, kind: 'code-text-index' as const, items: admitted.map(item => {
                                if (item.type !== 'text') return { type: item.type };
                                const result = capturedText.get(item)!;
                                if (result.kind !== 'ready') throw new FactRecoveryRequiredError();
                                return { type: 'text' as const, envelope: result.envelope };
                            }) } } : {})
                        });
                        // A canceled save that never issued an artifact operation is a
                        // known non-durable disposition; it is not "storage unknown".
                        if (retained?.kind === 'unavailable' && retained.reason === 'capture-canceled')
                            return retained;
                        // A save that already completed stays truthful even if the
                        // observer was stopped meanwhile; the original operation owns it.
                        if (!retained)
                            return { kind: 'unavailable', reason: 'no-owner' };
                        if (retained.kind === 'recovery-required')
                            throw new FactRecoveryRequiredError();
                        return retained;
                    })();
                    track(retaining.then(() => { }, () => { }), cell);
                    applyTextRetention(textRetention, await retaining, incomplete);
                }
                catch (error) {
                    if (options.retentionRecovery) {
                        // The observation already owns these real emitted items. Preserve
                        // that same window and captured reference stage through recovery.
                        const bytes = admitted.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0);
                        cell.retainedOutputBytes += bytes;
                        cell.retainedOutputItems += admitted.length;
                        cell.recoveryRequired = true;
                        if (!continueRetention)
                            options.retentionRecovery();
                        let settling: Promise<void> | undefined;
                        cell.pendingProjection = {
                            settle() {
                                if (settling)
                                    return settling;
                                const work = (async () => {
                                    if (!continueRetention)
                                        throw new FactRecoveryRequiredError();
                                    const retained = await continueRetention();
                                    if (retained.kind === 'recovery-required')
                                        throw new FactRecoveryRequiredError();
                                    applyTextRetention(textRetention!, retained, incomplete);
                                    cell.recoveredProjection = finishProjection();
                                    cell.pendingProjection = undefined;
                                    cell.retainedOutputBytes -= bytes;
                                    cell.retainedOutputItems -= admitted.length;
                                    if (!cell.pendingOutputReceipts && !cell.terminalReceiptPending)
                                        cell.recoveryRequired = false;
                                    cell.wake?.();
                                })();
                                settling = work;
                                void work.catch(() => {
                                    if (settling === work)
                                        settling = undefined;
                                });
                                return work;
                            }
                        };
                        throw new FactRecoveryRequiredError();
                    }
                    // A failed retention attempt is an explicit non-durable disposition;
                    // it never rewrites the guest's own execution outcome and never
                    // writes the huge text into the model window instead. Unknown stays
                    // recoverable through the original capture when a recovery owner was
                    // registered above; otherwise it is reported as unknown, not success.
                    textRetention.unavailable = 'storage-unknown';
                }
            }
        }
        return finishProjection();
        function finishProjection(): CodeModeObservation {
            const items: CodeModeItem[] = [];
            let remaining = Math.min(TEXT_CAP, tokens * 4);
            const error = cell.error === undefined ? undefined : textSlice(cell.error, remaining);
            if (error !== undefined) {
                truncated ||= error !== cell.error;
                remaining -= Buffer.byteLength(error);
            }
            let textCount = 0;
            for (const item of admitted) {
                if (item.type !== 'text') {
                    items.push(item);
                    continue;
                }
                const separator = textCount ? 1 : 0;
                const value = textSlice(item.text, Math.max(0, remaining - separator));
                if (value !== item.text)
                    truncated = true;
                if (value || (!item.text && remaining >= separator)) {
                    items.push({ type: 'text', text: value });
                    remaining -= Buffer.byteLength(value) + separator;
                    textCount++;
                }
                else if (!item.text)
                    truncated = true;
            }
            const text = items.filter((item): item is Extract<CodeModeItem, {
                type: 'text';
            }> => item.type === 'text').map(item => item.text).join('\n');
            if (textRetention)
                textRetention.omittedBytes = textRetention.admittedBytes - Buffer.byteLength(text);
            // A slow spill can overlap later output and guest completion. Keep the
            // observation cursor available until that later window is consumed.
            const status = cell.items.length || cell.truncated || cell.textIncomplete || cell.status === 'running' && cell.pendingItems ? 'running' : cell.status;
            const out: CodeModeObservation = {
                cellId: cell.id, status, items, text, truncated,
                ...(steered && cell.status === 'running' && !signal?.aborted ? { yielded: true as const, yieldReason: 'user-steer' as const } : {}),
                ...(textRetention ? { textRetention } : {}),
                ...(error === undefined ? {} : { error }), ...(cell.policyRefusal ? { policyRefusal: true } : {})
            };
            if (out.status !== 'running')
                state.retire(cell.id);
            else if (!passive && cell.status === 'running' && !cell.finishing)
                cell.worker.postMessage({ type: 'observed' });
            return out;
        }
    }
    function retainObservation(cell: Cell, tokens: number, retained: NonNullable<CodeModeObserveOptions['retained']>, cleanup: () => void): void {
        let finished = false, projecting = false;
        const wake = () => {
            if (finished || projecting)
                return;
            try {
                if (cell.recoveredProjection) {
                    const output = cell.recoveredProjection;
                    cell.recoveredProjection = undefined;
                    retained.ready(output);
                    finished = true;
                    cleanup();
                    cell.observer = false;
                    if (cell.wake === wake)
                        cell.wake = undefined;
                    return;
                }
                if (cell.recoveryRequired) {
                    retained.unavailable();
                    return;
                }
                if (cell.terminalReceiptPending || cell.status === 'running' && cell.finishing) {
                    retained.progress();
                    return;
                }
                if (cell.status === 'running') {
                    retained.unavailable();
                    return;
                }
                projecting = true;
                retained.progress();
                const projection = project(cell, tokens, false, undefined, true).then(output => {
                    retained.ready(output);
                    finished = true;
                    cleanup();
                    cell.observer = false;
                    if (cell.wake === wake)
                        cell.wake = undefined;
                }).catch(() => {
                    projecting = false;
                    try {
                        retained.unavailable();
                    }
                    catch { /* Original owner remains recovery-required. */ }
                });
                track(projection, cell);
            }
            catch { /* An invalid/closed original source cannot install an outcome. */ }
        };
        cell.wake = wake;
        wake();
    }
    async function observe(cell: Cell, duration: number, tokens: number, signal?: AbortSignal, terminate = false, observation?: CodeModeObserveOptions): Promise<CodeModeObservation> {
        if (cell.observer)
            throw new Error('Cell already has an active observer');
        observation?.retained?.observed();
        cell.observer = true;
        let removeAbort: (() => void) | undefined;
        let steered = false;
        let retained = false;
        try {
            if (terminate && cell.status === 'running')
                close(cell, 'terminated', 'Cell terminated by observer');
            if (signal?.aborted)
                close(cell, 'terminated', message(signal.reason ?? 'Observer aborted'));
            if (cell.status === 'running' && !cell.yielded || cell.terminalReceiptPending) {
                if (signal) {
                    const abort = () => close(cell, 'terminated', message(signal.reason ?? 'Observer aborted'));
                    signal.addEventListener('abort', abort, { once: true });
                    removeAbort = () => signal.removeEventListener('abort', abort);
                }
                const reason = await waitForObservation({
                    ready: () => cell.status !== 'running' && !cell.terminalReceiptPending || cell.yielded && !cell.terminalReceiptPending || cell.recoveryRequired === true,
                    changes: {
                        subscribe: wake => {
                            cell.wake = wake;
                            return () => {
                                if (cell.wake === wake)
                                    cell.wake = undefined;
                            };
                        }
                    },
                    timeoutMs: duration, abortSignal: signal, userSteer: observation?.userSteer,
                });
                steered = reason === 'user-steer';
            }
            if (cell.recoveryRequired || cell.terminalReceiptPending)
                throw new FactRecoveryRequiredError();
            return await project(cell, tokens, steered, signal);
        }
        catch (error) {
            if (observation?.retained && String((error as {
                code?: string;
            })?.code ?? '').startsWith('FACT_')) {
                retained = true;
                retainObservation(cell, tokens, observation.retained, () => removeAbort?.());
            }
            throw error;
        }
        finally {
            if (!retained) {
                removeAbort?.();
                cell.observer = false;
            }
        }
    }
    return { output, observe };
}
export type Output = ReturnType<typeof createOutput>;
