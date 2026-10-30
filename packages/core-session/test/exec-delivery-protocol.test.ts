import { describe, expect, it } from 'vitest';
import { createDeliveryIndex, readDeliveries, validateDeliveryFrame } from '../src/conversation/delivery.ts';
import { createNondurableFactOwner } from '../src/managed/nondurable.ts';
import { deliveryInputId, validDeliveryEvent } from '../src/events/delivery.ts';
import { validateConversationEventShape } from '../src/events/conversation.ts';
import { captureFactGroup, resolveFactGroup } from '../src/managed/groups.ts';
import { createSession } from '../src/events/append.ts';
import { managedResultRefs } from '../src/results/projection.ts';
import { committedFactSeqs } from '../src/managed/outcome.ts';
import type { Session } from '../src/events/types.ts';

const artifact = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'exec-frames-v1', encodedBytes: 12, contentDigest: 'c'.repeat(64), completeness: 'complete' } as const;
const source = { type: 'agent/delivery-source', version: 1, kind: 'exec', recipientSessionId: 'parent', generationId: 'g', sourceNamespace: 'exec', sourceId: 'original-instance', callSeq: 2, delivery: 'tool', seq: 4 } as const;
const terminal = { type: 'exec/end', version: 1, sourceSeq: 4, instanceId: source.sourceId, frameSourceId: 'process:original-execution', execution: { dispatch: 'dispatched', outcome: 'succeeded' }, exitCode: 0, timedOut: false, dependency: { kind: 'exec-frames', sourceId: 'process:original-execution', retention: { kind: 'artifact', ref: artifact } } } as const;
const handoff = { type: 'agent/delivery-handoff', version: 1, kind: 'exec', sourceSeq: 4 } as const;
const key = { recipientSessionId: 'parent', sourceNamespace: 'exec', sourceId: source.sourceId, resultRevision: artifact.revision, kind: 'exec' } as const;

function history(order: 'terminal-first' | 'handoff-first' | 'foreground' | 'background' = 'terminal-first') {
  const events: any[] = [
    { type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'work', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' }, seq: 0 },
    { type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'g', originInputSeq: 0, seq: 1 },
    { type: 'tool/call', name: 'shell', callId: 'call', args: { command: 'fixture' }, seq: 2 },
    { type: 'tool/dispatch', callId: 'call', eventSeq: 2, seq: 3 },
    { ...source, delivery: order === 'background' ? 'parent' : 'tool' },
  ];
  if (order === 'handoff-first') events.push({ ...handoff, seq: events.length });
  const terminalSeq = events.length;
  events.push({ ...terminal, seq: terminalSeq });
  if (order === 'terminal-first') events.push({ ...handoff, seq: events.length });
  const inputId = deliveryInputId(key as never);
  events.push({ type: 'agent/delivery-received', version: 1, key, sourceSeq: 4, terminalSeq, inputId, seq: events.length });
  events.push({ type: 'agent/input/admitted', version: 1, inputId, text: 'completed', delivery: 'steer', intent: 'system', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'session.delivery.exec' }, synthetic: { scope: 'turn', description: 'Original command completed', display: { kind: 'task', title: 'shell', body: 'completed' } }, seq: events.length });
  return events;
}
function read(events: any[]) { return readDeliveries({ formatVersion: 14, header: { sessionId: 'parent' }, events } as never); }

describe('required Exec delivery protocol', () => {
  it('keeps the original index as the pending-candidate owner across committed frames', () => {
    const events = history(), index = createDeliveryIndex({ sessionId: 'parent' });
    for (const event of events.slice(0, 5)) { const stage = index.stage(); stage.advance(event); stage.commit(); }
    expect(index.read().execPending()).toEqual([]);
    const end = index.stage(); end.advance(events[5]); end.commit();
    expect(index.read().execPending()).toEqual([]);
    const routed = index.stage(); routed.advance(events[6]); routed.commit();
    expect(index.read().execPending()).toMatchObject([{ source: { sourceId: source.sourceId }, terminal: { frameSourceId: terminal.frameSourceId } }]);
    const duplicate = index.stage(); expect(() => duplicate.advance({ ...events[5], seq: 7 })).toThrow(/duplicate/);
    expect(index.read().execPending()).toHaveLength(1);
    const received = index.stage(); received.advance(events[7]); received.advance(events[8]); received.commit();
    expect(index.read().execPending()).toEqual([]);
    expect(index.read().pending()).toHaveLength(1);
  });
  it('fences pending Exec candidates on generation close without erasing retained terminal facts', () => {
    const events = history().slice(0, -2);
    expect(read(events).execPending()).toHaveLength(1);
    events.push({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop', seq: events.length });
    expect(read(events).execPending()).toEqual([]);
    expect(managedResultRefs(events[5])).toEqual([artifact]);
  });
  it('does not emit the new source into an actual format-13 memory owner', async () => {
    const session: Session = { formatVersion: 13, events: [] };
    const owner = createNondurableFactOwner(session), action = owner.beginAction();
    expect(session.formatVersion).toBe(13);
    const { seq: _seq, ...event } = source;
    const captured = action.captureExecDeliverySource(event, () => true);
    await expect(captured.admit()).rejects.toMatchObject({ code: 'SESSION_CONVERSATION_FORMAT' });
    expect(session.events).toEqual([]); action.finish();
  });
  it('uses the actual memory action and settlement ports for the complete format-14 receipt', async () => {
    const session: Session = { formatVersion: 14, events: [] }, owner = createNondurableFactOwner(session);
    const received = owner.registerReceivedInputSource(async () => {}), action = owner.beginAction();
    committedFactSeqs(await received.captureAdmitted({ type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'work', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }).admit());
    committedFactSeqs(await received.captureDeliveryOpen({ type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'g', originInputSeq: 0 }, () => true).admit());
    const [callSeq] = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', name: 'shell', callId: 'actual', args: {} }));
    committedFactSeqs(await action.facts.tools.dispatch('actual', { kind: 'prior', seq: callSeq!, expectedType: 'tool/call' }));
    const { seq: _seq, ...binding } = source;
    const [sourceSeq] = committedFactSeqs(await action.captureExecDeliverySource({ ...binding, callSeq: callSeq! }, () => true).admit());
    const settle = action.registerSettlementSource(async () => {});
    const [terminalSeq] = committedFactSeqs(await settle.delivery.capture({ ...terminal, sourceSeq: sourceSeq! }).admit());
    expect(readDeliveries(session).execPending()).toEqual([]);
    committedFactSeqs(await settle.delivery.capture({ ...handoff, sourceSeq: sourceSeq! }).admit());
    expect(readDeliveries(session).execPending()).toHaveLength(1);
    const inputId = deliveryInputId(key), admitted = history().at(-1)!;
    const { seq: _inputSeq, ...input } = admitted;
    committedFactSeqs(await received.captureDeliveryAdmission({ type: 'agent/delivery-received', version: 1, key, sourceSeq: sourceSeq!, terminalSeq: terminalSeq!, inputId }, input, () => true).admit());
    expect(readDeliveries(session).receipt(key)).toMatchObject({ disposition: 'pending' });
    expect(readDeliveries(session).execPending()).toEqual([]);
    await settle.close(); action.finish(); await received.close();
  });
  it('captures source, handoff and terminal through closed original fact groups', () => {
    const { seq: _seq, ...binding } = source;
    expect(captureFactGroup({ kind: 'exec-delivery-source', event: binding } as never).kind).toBe('captured');
    for (const event of [handoff, terminal]) expect(captureFactGroup({ kind: 'delivery', event } as never).kind).toBe('captured');
    for (const event of [{ ...binding, seq: 4 }, { ...binding, extra: true }, { ...binding, kind: 'subagent' }]) expect(captureFactGroup({ kind: 'exec-delivery-source', event } as never).kind).toBe('not-issued');
  });
  it('keeps completed frame references readable without inheriting delivery authority', () => {
    expect(managedResultRefs({ ...terminal, seq: 5 } as never)).toEqual([artifact]);
    const captured = captureFactGroup({ kind: 'seed-import', events: [{ ...terminal, seq: 5 }] } as never);
    expect(captured.kind).toBe('captured');
    if (captured.kind === 'captured') expect(() => resolveFactGroup(captured.group, createSession(), 0)).toThrow(/authority/);
  });
  it('accepts closed original Exec facts only from format 14', () => {
    for (const event of [source, { ...handoff, seq: 5 }, { ...terminal, seq: 6 }]) {
      expect(validDeliveryEvent(event)).toBe(true);
      expect(() => validateConversationEventShape(event as never, 14)).not.toThrow();
      expect(() => validateConversationEventShape(event as never, 13)).toThrow();
      expect(() => validateDeliveryFrame([event] as never, 13)).toThrow();
    }
    expect(() => validateDeliveryFrame([source] as never, 14)).not.toThrow();
  });

  it.each(['terminal-first', 'handoff-first', 'background'] as const)('accepts one exact eligible receipt after %s routing', order => {
    const events = history(order), state = read(events), inputId = events.at(-1).inputId;
    expect(state.source('exec', source.sourceId)).toMatchObject({ kind: 'exec', sourceId: source.sourceId });
    expect(state.receipt(key as never)).toMatchObject({ disposition: 'pending' });
    expect(state.isEligible(inputId)).toBe(true);
    expect(state.pending()).toEqual([{ inputId, receiptSeq: events.length - 2 }]);
  });

  it('requires original Shell dispatch, parent handoff, terminal identity and retained completed frames', () => {
    expect(() => read(history('foreground'))).toThrow();
    const mutations: Array<(events: any[]) => void> = [
      events => { events[2].name = 'spawn_agent'; },
      events => { events[3].callId = 'other'; },
      events => { events[4].callSeq = 0; },
      events => { events[4].generationId = 'other'; },
      events => { events[5].instanceId = 'other'; },
      events => { events[5].sourceSeq = 2; },
      events => { events[5].dependency.sourceId = 'process:foreign'; },
      events => { events[5].dependency.retention.ref.completeness = 'producer-incomplete'; },
      events => { events[5].dependency.retention.ref.codec = 'json-utf8-v1'; },
      events => { events[5].execution.outcome = 'canceled'; },
      events => { events[7].key.resultRevision = 'd'.repeat(64); },
      events => { events[8].provenance.producer = 'session.delivery.subagent'; },
    ];
    for (const mutate of mutations) {
      const events = structuredClone(history()); mutate(events);
      expect(() => read(events)).toThrow();
    }
  });

  it('permits genuine failed commands and suppresses already-recorded receipts after Stop', () => {
    const events = structuredClone(history()); events[5].execution.outcome = 'failed'; events[5].exitCode = 2;
    expect(read(events).pending()).toHaveLength(1);
    events.push({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop', seq: events.length });
    expect(read(events).pending()).toEqual([]);
    expect(read(events).receipt(key as never)).toMatchObject({ disposition: 'suppressed' });
  });

  it('keeps subagent hash bytes unchanged and domain-separates Exec keys', () => {
    expect(deliveryInputId({ recipientSessionId: 'parent', sourceNamespace: 'registry', sourceId: 'task-1', resultRevision: 'original-revision', kind: 'subagent' })).toBe('delivery-b24de151161856ca392d0098301ef8778f0ee8967849c03cac92005a5035be64');
    expect(deliveryInputId(key as never)).not.toBe(deliveryInputId({ ...key, kind: 'subagent' }));
  });

  it('rejects accessors, hidden fields and mismatched dependency identity without running hooks', () => {
    let reads = 0;
    const getter = Object.defineProperty({ ...terminal }, 'dependency', { enumerable: true, get() { reads++; return terminal.dependency; } });
    for (const event of [getter, Object.defineProperty({ ...source }, 'extra', { value: true }), { ...source, startSeq: 3 }, { ...handoff, sourceSeq: -1 }, { ...terminal, frameSourceId: 'process:other' }]) expect(validDeliveryEvent(event)).toBe(false);
    expect(reads).toBe(0);
  });
  it('returns false rather than throwing for scalar or array nested proof fields', () => {
    for (const value of ['invalid', 1, true, [], null]) {
      expect(validDeliveryEvent({ ...terminal, execution: value })).toBe(false);
      expect(validDeliveryEvent({ ...terminal, dependency: value })).toBe(false);
      expect(validDeliveryEvent({ ...terminal, dependency: { ...terminal.dependency, retention: value } })).toBe(false);
    }
  });
  it('reads result type as own data without executing an accessor', () => {
    let reads = 0;
    const event = Object.defineProperty({ ...terminal }, 'type', { enumerable: true, get() { reads++; return 'exec/end'; } });
    expect(() => managedResultRefs(event)).toThrow();
    expect(reads).toBe(0);
  });
});
