import { expect, it } from 'vitest';
import { createConversationValidationScan, inspectConversationValidationScan, readConversationGenerations, readConversationDeliveries, takeConversationValidationScan } from '../src/conversation/validation.ts';
import { createConversationValidationIndex } from '../src/index.ts';
import type { SessionEvent } from '../src/events/types.ts';
it('scans original complete validation and selection without retaining the source array', async () => {
    const events: SessionEvent[] = [{ type: 'turn/start', seq: 0 }, { type: 'user/message', text: 'task', seq: 1 }, { type: 'step/start', seq: 2 }, { type: 'assistant/message', text: 'old', seq: 3 }, { type: 'step/end', seq: 4 }, { type: 'turn/end', seq: 5 }];
    const full = createConversationValidationIndex(events, { formatVersion: 14 });
    const scan = createConversationValidationScan({ formatVersion: 14, readEvent: async (ordinal) => events[ordinal]! });
    for (const event of events)
        await scan.push([event]);
    const candidate = scan.finish();
    expect(inspectConversationValidationScan(candidate)).toEqual({ eventCount: events.length, history: full.history(), resultFacts: full.resultFacts(), generations: readConversationGenerations(full), delivery: { active: readConversationDeliveries(full)?.activeGeneration(), pending: readConversationDeliveries(full)?.pending() } });
    expect(() => inspectConversationValidationScan({})).toThrow();
    expect(() => scan.finish()).toThrow();
});
it('a failed original semantic advance permanently poisons its unfinished scan', async () => {
    const scan = createConversationValidationScan({ formatVersion: 14, readEvent: async () => {
            throw Error('unexpected hydration');
        } });
    await expect(scan.push([{ type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 0 }, { type: 'tool/dispatch', callId: 'unaccepted', seq: 1 }])).rejects.toThrow();
    expect(() => scan.finish()).toThrow();
});
import { createSession, createNondurableFactOwner } from '../src/index.ts';
async function preparedFixture() {
    const source = createSession(), action = createNondurableFactOwner(source).beginAction();
    await action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'raw', text: '/raw', delivery: 'queue', intent: 'user', preparationPolicy: 'human-host', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } });
    await action.captureGeneration([{ type: 'context/action', version: 1, op: 'open', ownerSessionId: 'document', actionId: 'generation', purpose: 'main', origin: { kind: 'input', seq: 0 }, startedAt: 100, expiresAt: 3600100, trustedAt: 100 }], () => true).admit();
    const envelope = { type: 'agent/input/preparation' as const, version: 1 as const, preparationId: 'prepare', actionId: 'generation', actionSeq: 1, admissionSeq: 0, inputId: 'raw' };
    await action.captureInputPreparation({ ...envelope, op: 'started', startedAt: 100 }, () => true).admit();
    const settlement = action.registerSettlementSource(async () => {
    }), result = { ...envelope, op: 'completed' as const, observations: [{ producer: 'host-preparation' as const, text: 'expanded observation' }] };
    await settlement.inputPreparation.capture(result).admit();
    await action.facts.inputs.start({ type: 'agent/input/promoted', version: 1, inputId: 'raw' }, { type: 'user/message', text: '/raw', input: { inputId: 'raw', intent: 'user' }, provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }, { ...result, seq: 3 });
    await settlement.close();
    action.finish();
    return source;
}
it('defers original atomic preparation end constraints until whole scan finish and hydrates exact earlier bodies', async () => {
    const source = await preparedFixture(), reads: number[] = [];
    const full = createConversationValidationIndex(source.events, { formatVersion: source.formatVersion });
    const scan = createConversationValidationScan({ formatVersion: source.formatVersion, readEvent: async (ordinal) => {
            reads.push(ordinal);
            return source.events[ordinal]!;
        } });
    for (const event of source.events)
        await scan.push([event]);
    const restored = inspectConversationValidationScan(scan.finish());
    expect(restored.history).toEqual(full.history());
    expect(restored.generations).toEqual(readConversationGenerations(full));
    expect(restored.delivery.pending).toEqual(readConversationDeliveries(full)?.pending());
    expect(reads).toContain(0);
    expect(reads).toContain(3);
});
it('does not defer or skip exact prepared text equality across physical units', async () => {
    const source = await preparedFixture(), scan = createConversationValidationScan({ formatVersion: source.formatVersion, readEvent: async (ordinal) => source.events[ordinal]! });
    const changed = source.events.map(event => event.type === 'user/message' ? { ...event, text: 'different' } : event);
    await expect((async () => {
        for (const event of changed)
            await scan.push([event]);
        scan.finish();
    })()).rejects.toThrow('prepared input text mismatch');
});
it('refuses unfinished preparation linkage at the original finish boundary', async () => {
    const source = await preparedFixture();
    const events = source.events.slice(0, -1);
    const scan = createConversationValidationScan({ formatVersion: source.formatVersion, readEvent: async (ordinal) => events[ordinal]! });
    for (const event of events)
        await scan.push([event]);
    expect(() => scan.finish()).toThrow('prepared input requires atomic promotion linkage');
});
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFactJournal } from '../src/index.ts';
it('original semantic birth readiness is enforced at finish rather than prematurely between scan units', async () => {
    const raw = readFileSync(join(import.meta.dirname, '../../session-persistence-jsonl/test/fixtures/bootstrap13-public/target.jsonl')), end = raw.indexOf(10), header = JSON.parse(raw.subarray(0, end).toString('utf8')), decoded = readFactJournal(raw.subarray(end + 1), header.journal, header.formatVersion, header);
    const incomplete = createConversationValidationScan({ formatVersion: header.formatVersion, header, readEvent: async (ordinal) => decoded.events[ordinal]! });
    await incomplete.push([]);
    expect(() => incomplete.finish()).toThrow('bootstrap-incomplete');
    const complete = createConversationValidationScan({ formatVersion: header.formatVersion, header, readEvent: async (ordinal) => decoded.events[ordinal]! });
    for (const event of decoded.events)
        await complete.push([event]);
    expect(inspectConversationValidationScan(complete.finish()).eventCount).toBe(decoded.events.length);
});

it('a completed private immutable birth is not replayed for a warm metadata-only suffix',async()=>{
 const raw=readFileSync(join(import.meta.dirname,'../../session-persistence-jsonl/test/fixtures/bootstrap13-public/target.jsonl')),end=raw.indexOf(10),header=JSON.parse(raw.subarray(0,end).toString('utf8')),decoded=readFactJournal(raw.subarray(end+1),header.journal,header.formatVersion,header)
 for(const event of decoded.events)Object.freeze(event)
 const scan=createConversationValidationScan({formatVersion:header.formatVersion,header,readEvent:async ordinal=>decoded.events[ordinal]!});await scan.push(decoded.events);const index=takeConversationValidationScan(scan.finish());let reads=0;index.stage([{type:'plan/mode',mode:'on',seq:decoded.events.length}],{readCurrentEvent(){reads++;throw Error('warm birth payload replay')}}).commit();expect(reads).toBe(0);expect(index.eventCount).toBe(decoded.events.length+1)
})
