import { validateDeliveryFrame } from '../src/conversation/delivery.ts';
import { expect, it } from 'vitest';
import { validateConversationEventShape } from '../src/events/conversation.ts';
it('rejects new required delivery facts under format12 and closed-data mutations', () => {
  const close = { type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop', seq: 0 } as const;
  expect(() => validateConversationEventShape(close, 12)).toThrow();
  expect(() => validateConversationEventShape(close, 13)).not.toThrow();
  for (const mutation of [{ ...close, extra: true }, { ...close, fenceId: undefined }, { ...close, reason: 'other' }])
    expect(() => validateConversationEventShape(mutation as never, 13)).toThrow();
});
it('rejects source pairs split over physical frames', () => {
  const start = { type: 'subagent/start', version: 1, taskId: 'task-1', parentSessionId: 'parent', agentPath: 'a', role: 'r', description: 'd', seq: 3 } as const;
  const binding = { type: 'agent/delivery-source', version: 1, kind: 'subagent', recipientSessionId: 'parent', generationId: 'g', sourceNamespace: 'ns', sourceId: 'task-1', callSeq: 1, startSeq: 3, seq: 4 } as const;
  expect(() => validateDeliveryFrame([start, binding], 13)).not.toThrow();
  expect(() => validateDeliveryFrame([binding], 13)).toThrow();
  expect(() => validateDeliveryFrame([start, binding], 12)).toThrow();
});
it('rejects a forged delivery producer without its physical receipt', () => {
  const admitted = { type: 'agent/input/admitted', version: 1, inputId: 'fake', text: 'text', delivery: 'steer', intent: 'system', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'session.delivery.subagent' }, seq: 1 } as const;
  expect(() => validateDeliveryFrame([admitted], 13)).toThrow();
});
it('rejects hidden, accessor, symbol and undefined delivery fields without executing hooks', async () => {
  const { captureFactGroup } = await import('../src/managed/groups.ts');
  const close = { type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop' } as const;
  let reads = 0;
  const accessor = Object.defineProperty({ ...close }, 'reason', { enumerable: true, get() { reads++; return 'user-stop'; } });
  const hidden = Object.defineProperty({ ...close }, 'extra', { value: 1 });
  for (const event of [accessor, hidden, { ...close, seq: undefined }, { ...close, [Symbol('extra')]: true }])
    expect(captureFactGroup({ kind: 'delivery-generation', event } as never).kind).toBe('not-issued');
  const binding = Object.defineProperty({ recipientSessionId: 'parent', generationId: 'g', sourceNamespace: 'ns', sourceId: 'task-1', callSeq: 1 }, 'hidden', { value: true });
  expect(captureFactGroup({ kind: 'subagent-delivery-start', start: { type: 'subagent/start', version: 1, taskId: 'task-1', agentPath: 'a', role: 'r', description: 'd', parentSessionId: 'parent' }, binding }).kind).toBe('not-issued');
  expect(reads).toBe(0);
});
it('refuses delivery authority as inherited seed while preserving ordinary context export', async () => {
  const { createSession, createNondurableFactOwner, captureFactGroup, resolveFactGroup, exportConversationSeed, readDeliveries } = await import('../src/index.ts');
  const event = { type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'f', reason: 'rewind', seq: 0 } as const;
  const capture = captureFactGroup({ kind: 'seed-import', events: [event] });
  if (capture.kind !== 'captured')
    throw Error('seed setup');
  expect(() => resolveFactGroup(capture.group, createSession(), 0)).toThrow(/authority/);
  const memory = createSession(), owner = createNondurableFactOwner(memory), received = owner.registerReceivedInputSource(async () => { });
  expect(await received.captureDeliveryClose({ ...event, seq: undefined }).admit()).toMatchObject({ kind: 'not-issued' });
  const closed = await received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'actual', reason: 'rewind' }).admit();
  expect(closed).toMatchObject({ kind: 'memory-committed', durability: 'nondurable' });
  expect(readDeliveries(memory).activeGeneration()).toBeUndefined();
  const exported = exportConversationSeed(memory, { kind: 'session', sessionId: 'parent' }, { kind: 'all' });
  expect(exported.kind).toBe('seed');
  expect(JSON.stringify(exported)).not.toContain('agent/delivery-generation');
});
it('uses a domain-separated typed tuple for the canonical id',async()=>{
 const {deliveryInputId}=await import('../src/events/delivery.ts')
 expect(deliveryInputId({recipientSessionId:'parent',sourceNamespace:'registry',sourceId:'task-1',resultRevision:'original-revision',kind:'subagent'})).toBe('delivery-b24de151161856ca392d0098301ef8778f0ee8967849c03cac92005a5035be64')
})
