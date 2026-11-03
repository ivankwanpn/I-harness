import { deriveContextRecovery, deriveContextBudget } from '@i-harness/core-session';
import { expect, it } from 'vitest';
import { captureContextSnapshot } from '../src/index.ts';
import { captureRestoredContextSnapshot } from '../src/snapshot/build.ts';
import { restoreManagedConversation, installRestoredManagedConversation, readRestoredConversation, readRestoredRecovery, readRestoredBudget } from '../../core-session/src/managed/restored-view.ts';
import type { OriginalConversationRestorationSource } from '../../core-session/src/conversation/restoration-input.ts';
import type { Session } from '@i-harness/core-session';
const input = { ownerSessionId: 'owner', surface: { systemPrompt: 'system', tools: [] } };
function fixture(orphan = false) {
    const excluded = 'OLD-EXCLUDED-PAYLOAD-'.repeat(1000), rawResult = 'PRUNED-RAW-BODY-'.repeat(1000);
    const session: Session = { formatVersion: 14, events: [{ type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'task' }, { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: excluded }, { type: 'step/end', seq: 4 }, { type: 'step/start', seq: 5 }, { type: 'tool/call', seq: 6, callId: 'c', name: 'read', args: {} }, { type: 'assistant/message', seq: 7, text: 'tail', thinkingBlocks: [{ type: 'thinking', thinking: 'native reasoning', signature: 'signed' }], providerContinuation: { kind: 'anthropic', model: 'literal', contentOrder: [{ kind: 'reasoning', index: 0 }, { kind: 'text', text: 'tail' }, { kind: 'tool', index: 0 }], producerWitness: { version: 1, thinkingConfigId: 'a'.repeat(64), effortConfigId: 'b'.repeat(64), interleavedBeta: false, mode: 'absent', interleaving: 'unknown' } } }, { type: 'tool/result', seq: 8, callId: 'c', name: 'read', output: { text: rawResult, images: [{ mediaType: 'image/png', dataBase64: 'eA==' }] } }, { type: 'step/end', seq: 9 }, { type: 'turn/end', seq: 10 }, { type: 'compaction/replacement', version: 1, seq: 11, replacementId: 'r', text: 'summary', coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }], insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } }, { type: 'compaction/prune', version: 1, seq: 12, pruned: [{ callId: 'c', head: 'head', tail: 'tail', removedBytes: rawResult.length }] }] };
    const recovery = { type: 'context/recovery' as const, version: 1 as const, ownerSessionId: 'owner', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), modelId: 'model', protocol: 'chat' };
    session.events.push({ ...recovery, recoveryId: 'old', providerId: 'p', state: 'retry-started', seq: 13 }, { ...recovery, recoveryId: 'new', providerId: 'q', state: 'required', seq: 14 }, { ...recovery, recoveryId: 'old', providerId: 'p', state: 'blocked', seq: 15 }, { ...recovery, recoveryId: 'new', providerId: 'q', state: 'resolved', seq: 16 });
    const budget = { version: 1 as const, ownerSessionId: 'owner', modelId: 'model', protocol: 'chat', bindingFingerprint: 'a'.repeat(64), bindingRevision: 0, projectionRevision: 0, neutralFingerprint: 'b'.repeat(64), identityCoverage: 'partial' as const, estimatedInputTokens: 100, admissionInputTokens: 100, estimateSource: 'projected-heuristic' as const, coverage: 'complete' as const, confidence: 'estimated' as const, roleTokens: { user: 100, assistant: 0, tool: 0 }, systemTokens: 0, schemaTokens: 0, reasoningTokens: 0, outputReserve: 100, capSupport: 'unknown' as const, safetyMargin: 1, admission: 'fit' as const, recoveryRequired: false, fullByProvider: false };
    session.events.push({ type: 'context/budget', version: 1, snapshot: budget, seq: 17 }, { type: 'context/budget', version: 1, snapshot: { ...budget, estimatedInputTokens: 50, admissionInputTokens: 50 }, seq: 18 }, { type: 'agent/input/admitted', version: 1, inputId: 'pending', text: 'next task', delivery: 'queue', intent: 'user', seq: 19 }, { type: 'subagent/start', version: 1, taskId: 'pending-child', agentPath: '/child', role: 'research', description: 'pending', seq: 20 });
    session.events.push({ type: 'turn/start', seq: 21 }, { type: 'user/message', seq: 22, text: 'next task' }, { type: 'step/start', seq: 23 }, { type: 'tool/call', seq: 24, callId: 'unpruned', name: 'read', args: {} }, { type: 'assistant/message', seq: 25, text: 'unpruned round' }, { type: 'tool/result', seq: 26, callId: 'unpruned', name: 'read', output: 'required complete body' }, { type: 'step/end', seq: 27 }, { type: 'turn/end', seq: 28 });
    if (orphan)
        session.events.push({ type: 'tool/result', seq: 29, callId: 'orphan', name: 'diagnostic', output: 'ORPHAN-EXCLUDED-'.repeat(1000) }, { type: 'compaction/prune', version: 1, seq: 30, pruned: [{ callId: 'orphan', head: 'orphan-head', tail: 'orphan-tail', removedBytes: 16000 }] });
    let current = true, reads = 0, changeDuringRead = false, settleFailure = false, settles = 0;
    const source: OriginalConversationRestorationSource = {
        formatVersion: 14, prefix: { eventCount: session.events.length, bodyBytes: 0, prefixDigest: 'a'.repeat(64) }, assertCurrent() {
            if (!current)
                throw Error('source changed');
        }, async consume(accept) {
            for (const event of session.events)
                await accept([event]);
        }, async readEvent(index) {
            reads++;
            if (changeDuringRead)
                current = false;
            return session.events[index]!;
        }, async settle() {
            settles++;
            if (settleFailure)
                throw 0;
        }, async close() {
            current = false;
        }, appendCommitted() {
            throw Error('not this fixture');
        }
    };
    return {
        session, source, change() {
            current = false;
        }, changeOnRead() {
            changeDuringRead = true;
        }, failSettle() {
            settleFailure = true;
        }, settles: () => settles, reads: () => reads
    };
}
it('nominal restored lease reaches actual context capture with identical coordinates and prune payload, without retired history', async () => {
    const f = fixture(), owner = {}, candidate = await restoreManagedConversation(f.source, owner, 'owner');
    expect(() => installRestoredManagedConversation({}, owner)).toThrow();
    expect(() => installRestoredManagedConversation(candidate, {})).toThrow();
    const state = installRestoredManagedConversation(candidate, owner);
    expect(() => installRestoredManagedConversation(candidate, owner)).toThrow();
    const lease = await state.prepare();
    readRestoredConversation(lease, { ownerSessionId: 'owner' });
    expect(captureRestoredContextSnapshot(lease, input)).toEqual(captureContextSnapshot(f.session, input));
    expect(() => lease.preparedEvent(3)).toThrow('CONVERSATION_PAYLOAD_NOT_PREPARED');
    expect(() => lease.preparedEvent(8)).toThrow('CONVERSATION_PAYLOAD_NOT_PREPARED');
    expect(lease.preparedResult(8)).toMatchObject({ kind: 'pruned-result', media: [{ mediaType: 'image/png', dataBase64: 'eA==' }], prune: { head: 'head', tail: 'tail' } });
    expect(JSON.stringify(lease.preparedResult(8))).not.toContain('PRUNED-RAW-BODY');
    expect(lease.preparedResult(26)).toMatchObject({ kind: 'complete-result', event: { output: 'required complete body' } });
    expect(readRestoredRecovery(lease, 'owner', { modelId: 'model', protocol: 'chat' })).toEqual(deriveContextRecovery(f.session, 'owner', { modelId: 'model', protocol: 'chat' }));
    expect(readRestoredRecovery(lease, 'owner', { modelId: 'model', protocol: 'chat' })).toMatchObject({ recoveryId: 'old', state: 'blocked', retryConsumed: true });
    expect(readRestoredBudget(lease, 'owner')).toEqual(deriveContextBudget(f.session, 'owner'));
    const before = f.reads();
    captureRestoredContextSnapshot(lease, input);
    expect(f.reads()).toBe(before);
    expect(captureRestoredContextSnapshot({ ...lease }, input)).toMatchObject({ kind: 'unsupported' });
    await lease.settle();
    expect(() => lease.preparedEvent(1)).toThrow('CONVERSATION_PREPARATION_EXPIRED');
    expect(captureRestoredContextSnapshot(lease, input)).toMatchObject({ kind: 'unsupported' });
    await state.close();
});
it('source change during hydration publishes no prepared lease', async () => {
    const f = fixture(), candidate = await restoreManagedConversation(f.source, {}, 'owner');
    const owner = {};
    const other = fixture(), actual = await restoreManagedConversation(other.source, owner, 'owner');
    const state = installRestoredManagedConversation(actual, owner);
    other.changeOnRead();
    await expect(state.prepare()).rejects.toThrow('source changed');
    expect(() => installRestoredManagedConversation(candidate, owner)).toThrow();
    await state.close();
});
it('failed original preparation settlement publishes no lease and preserves falsey cleanup debt', async () => {
    const f = fixture(), owner = {}, candidate = await restoreManagedConversation(f.source, owner, 'owner'), state = installRestoredManagedConversation(candidate, owner);
    f.failSettle();
    await expect(state.prepare()).rejects.toBe(0);
    expect(state.needsPreparation()).toBe(true);
    expect(f.settles()).toBe(2);
    await state.close();
});
it('source method substitution refuses active use but cleanup retains original receiver and method', async () => {
    const f = fixture(), owner = {}, candidate = await restoreManagedConversation(f.source, owner, 'owner'), state = installRestoredManagedConversation(candidate, owner);
    f.source.readEvent = async () => {
        throw Error('foreign source method must not run');
    };
    await expect(state.prepare()).rejects.toMatchObject({ code: 'CONVERSATION_RESTORATION_SOURCE_CHANGED' });
    await state.close();
});
it('a proxy source cannot substitute original factory ports or execute traps', async () => {
    const f = fixture();
    let traps = 0;
    const source = new Proxy(f.source, {
        get() {
            traps++;
            throw Error('get trap');
        }, ownKeys() {
            traps++;
            throw Error('keys trap');
        }, getPrototypeOf() {
            traps++;
            throw Error('prototype trap');
        }
    });
    await expect(restoreManagedConversation(source, {}, 'owner')).rejects.toMatchObject({ code: 'CONVERSATION_RESTORATION_SOURCE_CHANGED' });
    expect(traps).toBe(0);
});
it('pruned result provenance uses original metadata without demanding an excluded full result event', async () => {
    const f = fixture(true), owner = {}, candidate = await restoreManagedConversation(f.source, owner, 'owner'), state = installRestoredManagedConversation(candidate, owner), lease = await state.prepare();
    const restored = captureRestoredContextSnapshot(lease, input);
    expect(restored.kind).toBe('captured');
    expect(restored).toEqual(captureContextSnapshot(f.session, input));
    expect(() => lease.preparedEvent(29)).toThrow('CONVERSATION_PAYLOAD_NOT_PREPARED');
    expect(JSON.stringify(lease.preparedResult(29))).not.toContain('ORPHAN-EXCLUDED-');
    await lease.settle();
    await state.close();
});
