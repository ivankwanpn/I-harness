import { expect, it, vi } from 'vitest';
const installCut = vi.hoisted(() => ({ enabled: false }));
const deliveryReads = vi.hoisted(() => ({ enabled: false, replays: 0, prefixEvents: 0 }));
vi.mock('../../core-session/src/conversation/delivery.ts', async load => {
  const api = await load<typeof import('../../core-session/src/conversation/delivery.ts')>();
  const observe = (view: import('@i-harness/core-session').SessionView) => { if (deliveryReads.enabled) { deliveryReads.replays++; deliveryReads.prefixEvents += view.events.length; } };
  return { ...api,
    readDeliveries: (...args: Parameters<typeof api.readDeliveries>) => { observe(args[0]); return api.readDeliveries(...args); },
    ...(api.readDeliveryIndex ? { readDeliveryIndex: (...args: Parameters<typeof api.readDeliveryIndex>) => { observe(args[0]); return api.readDeliveryIndex(...args); } } : {}),
  };
});

vi.mock('@i-harness/core-session', async (load) => {
  const api = await load<typeof import('@i-harness/core-session')>(); return {
    ...api, createManagedSessionState: (...args: Parameters<typeof api.createManagedSessionState>) => {
      const state = api.createManagedSessionState(...args), stage = state.stage; state.stage = events => {
        const prepared = stage(events); return {
          ...prepared, install() {
            if (installCut.enabled && events.some(e => e.type === 'agent/delivery-received')) {
              installCut.enabled = false;
              throw Error('controlled original install failure');
            } prepared.install();
          }
        };
      }; return state;
    }
  };
});
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { committedFactSeqs, deliveryInputId, readDeliveries, validateDeliveryFrame, createManagedSessionState, readGenerationActions, AsyncInbox, readInbox, type SessionEvent } from '@i-harness/core-session';
import { createSessionCoordinator } from '../src/index.ts';
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts';
async function ownedDeliveryHistory(admitReceipt = true) {
  const root = await mkdtemp(join(tmpdir(), 'delivery-owned-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } });
  await coordinator.create({ sessionId: 'parent' });
  const document = await coordinator.openManagedDocument('parent'), received = document.registerReceivedInputSource(async () => { }), action = document.beginAction();
  committedFactSeqs(await received.captureAdmitted({ type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'launch', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }).admit());
  const originInputSeq = 0;
  committedFactSeqs(await received.captureDeliveryOpen({ type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'g', originInputSeq }, () => true).admit());
  const [callSeq] = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', callId: 'spawn', name: 'spawn_agent', args: {} }));
  committedFactSeqs(await action.facts.tools.dispatch('spawn', { kind: 'prior', seq: callSeq!, expectedType: 'tool/call' }));
  const start = action.captureSubagentStart({ type: 'subagent/start', version: 1, taskId: 'task-1', parentSessionId: 'parent', agentPath: 'a', role: 'worker', description: 'work' }, { recipientSessionId: 'parent', generationId: 'g', sourceNamespace: 'registry', sourceId: 'task-1', callSeq: callSeq! });
  const startSeqs = committedFactSeqs(await start.admit()), sourceSeq = startSeqs[1]!;
  const terminal = action.registerSettlementSource(async () => { });
  const [terminalSeq] = committedFactSeqs(await terminal.delivery.capture({ type: 'subagent/end', version: 1, taskId: 'task-1', outcome: 'completed', resultRevision: 'original-revision', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'inline', value: 'original result', encodedBytes: 17 } } }).admit());
  const key = { recipientSessionId: 'parent', sourceNamespace: 'registry', sourceId: 'task-1', resultRevision: 'original-revision', kind: 'subagent' } as const, inputId = deliveryInputId(key);
  const admitted = { type: 'agent/input/admitted', version: 1, inputId, text: 'original result', intent: 'system', delivery: 'steer', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'session.delivery.subagent' }, synthetic: { description: 'work', scope: 'turn', display: { kind: 'task', title: 'work', body: 'original result' } } } as const;
  const receipt = { type: 'agent/delivery-received', version: 1, key, sourceSeq, terminalSeq: terminalSeq!, inputId } as const;
  if (admitReceipt)
    committedFactSeqs(await received.captureDeliveryAdmission(receipt, admitted, () => true).admit());
  return { coordinator, backend, document, root, sourceSeq, terminalSeq: terminalSeq!, inputId, received, action, admitted, receipt, key, async close() { await terminal.close(); action.finish(); await received.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }); } };
}
it('commits real original start/end and receipt pairs with frozen source owner identity', async () => {
  const f = await ownedDeliveryHistory();
  try {
    expect(readDeliveries(f.document.view).receipt(f.key)).toMatchObject({ disposition: 'pending' });
    expect(f.received.owner).toMatchObject({ sessionId: 'parent' });
    expect(Object.isFrozen(f.received.owner)).toBe(true);
    const physical = await f.backend.read('parent');
    expect(physical.events).toEqual(f.document.view.events);
  }
  finally {
    await f.close();
  }
});
it('rejects a receipt split from its admission across complete frames', async () => {
  const f = await ownedDeliveryHistory();
  try {
    const paired = f.document.view.events.filter(e => e.type === 'agent/delivery-received' || e.type === 'agent/input/admitted' && e.inputId === f.inputId);
    expect(paired).toHaveLength(2);
    expect(() => validateDeliveryFrame([paired[0]!], 13)).toThrow();
    expect(() => validateDeliveryFrame([paired[1]!], 13)).toThrow();
    expect(() => validateDeliveryFrame(paired, 13)).not.toThrow();
    expect(() => validateDeliveryFrame(paired, 12)).toThrow();
  }
  finally {
    await f.close();
  }
});
it.each(['sourceSeq', 'terminalSeq', 'recipient', 'revision', 'callSeq', 'startSeq', 'provenance'] as const)('rejects one mutated real owned reference: %s', async (field) => {
  const f = await ownedDeliveryHistory();
  try {
    const events = JSON.parse(JSON.stringify(f.document.view.events)) as SessionEvent[], receipt = events.find(e => e.type === 'agent/delivery-received')!, source = events.find(e => e.type === 'agent/delivery-source')!;
    if (receipt.type !== 'agent/delivery-received' || source.type !== 'agent/delivery-source' || source.kind !== 'subagent')
      throw Error('fixture');
    if (field === 'sourceSeq' || field === 'terminalSeq')
      receipt[field] = 0;
    if (field === 'recipient')
      receipt.key.recipientSessionId = 'foreign';
    if (field === 'revision')
      receipt.key.resultRevision = 'forged';
    if (field === 'callSeq' || field === 'startSeq')
      source[field] = 0;
    if (field === 'provenance') {
      const admitted = events.at(-1)!;
      if (admitted.type === 'agent/input/admitted')
        admitted.provenance!.producer = 'forged';
    }
    expect(() => createManagedSessionState({ formatVersion: 13, events }, { sessionId: 'parent' })).toThrow();
  }
  finally {
    await f.close();
  }
});
const open = (seq: number, actionId: string, origin: import('@i-harness/core-session').GenerationOrigin) => ({ type: 'context/action', version: 1, op: 'open', ownerSessionId: 'parent', actionId, purpose: 'main', origin, startedAt: 1, expiresAt: 100, trustedAt: 1, seq } as const);
it.each(['before', 'after'] as const)('preserves exact original finite action through consumed historical replay (%s promotion)', async (order) => {
  const f = await ownedDeliveryHistory();
  try {
    const admission = f.document.view.events.find(e => e.type === 'agent/input/admitted' && e.inputId === f.inputId)!;
    if (order === 'before')
      committedFactSeqs(await f.action.captureGeneration([open(0, 'finite', { kind: 'observation-input', seq: admission.seq!, inputId: f.inputId })], () => true).admit());
    committedFactSeqs(await f.action.facts.inputs.start({ type: 'agent/input/promoted', version: 1, inputId: f.inputId }, { type: 'user/message', text: f.admitted.text, provenance: f.admitted.provenance, input: { inputId: f.inputId, intent: 'system', synthetic: f.admitted.synthetic, provenance: f.admitted.provenance } }));
    const raw = f.document.view.events.findLast(e => e.type === 'user/message')!;
    if (order === 'after')
      committedFactSeqs(await f.action.captureGeneration([open(0, 'finite', { kind: 'input', seq: raw.seq! })], () => true).admit());
    const first = readGenerationActions(f.document.view.events, { sessionId: 'parent' }, 13).find(a => a.opened.actionId === 'finite')!;
    expect(first).toBeDefined();
    expect(readDeliveries(f.document.view).receipt(f.key)?.disposition).toBe('claimed');
    const second = await f.action.captureGeneration([open(0, 'second', order === 'before' ? { kind: 'input', seq: raw.seq! } : { kind: 'observation-input', seq: admission.seq!, inputId: f.inputId })], () => true).admit();
    expect(second).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' });
    const close = f.received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop' });
    expect(readGenerationActions(f.document.view.events, { sessionId: 'parent' }, 13).find(a => a.opened.actionId === 'finite')?.opened).toEqual(first.opened);
    committedFactSeqs(await close.admit());
    expect(readGenerationActions(f.document.view.events, { sessionId: 'parent' }, 13).find(a => a.opened.actionId === 'finite')?.opened).toEqual(first.opened);
  }
  finally {
    await f.close();
  }
});
it('revokes executable pending synchronously and guards original promotion at backend beforeIssue', async () => {
  const f = await ownedDeliveryHistory();
  try {
    const inbox = new AsyncInbox(f.document.view, () => f.action.facts.inputs);
    expect(inbox.isPending(f.inputId)).toBe(true);
    const append = f.backend.appendOwnedBatch!.bind(f.backend), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.backend.appendOwnedBatch = async (...args) => {
      if (JSON.parse(Buffer.from(args[3].bytes).toString()).events.some((e: {
        type: string;
      }) => e.type === 'agent/input/promoted')) {
        entered.resolve();
        await release.promise;
      } return append(...args);
    };
    const claim = f.action.facts.inputs.claim({ type: 'agent/input/promoted', version: 1, inputId: f.inputId }, { type: 'user/message', text: f.admitted.text, input: { inputId: f.inputId, intent: 'system' } });
    await entered.promise;
    const close = f.received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop' });
    expect(inbox.isPending(f.inputId)).toBe(false);
    expect(readInbox(f.document.view).isPending(f.inputId)).toBe(true);
    release.resolve();
    expect(await claim).toMatchObject({ kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' });
    committedFactSeqs(await close.admit());
    expect(await inbox.cancel(f.inputId)).toBe(true);
  }
  finally {
    await f.close();
  }
});
it('confirms Stop debt before a later own human can open a new generation without reviving old bindings', async () => {
  const f = await ownedDeliveryHistory();
  try {
    const close = f.received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop-one', reason: 'user-stop' });
    committedFactSeqs(await close.admit());
    const second = f.received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop-two', reason: 'user-stop' });
    const [human] = committedFactSeqs(await f.received.captureAdmitted({ type: 'agent/input/admitted', version: 1, inputId: 'later-human', text: 'new work', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }).admit());
    const open = f.received.captureDeliveryOpen({ type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'later', originInputSeq: human! }, () => true);
    expect(await open.admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' });
    committedFactSeqs(await second.admit());
    const [freshHuman] = committedFactSeqs(await f.received.captureAdmitted({ type: 'agent/input/admitted', version: 1, inputId: 'fresh-human', text: 'after confirmed stop', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }).admit());
    committedFactSeqs(await f.received.captureDeliveryOpen({ type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'fresh', originInputSeq: freshHuman! }, () => true).admit());
    expect(readDeliveries(f.document.view).activeGeneration()?.generationId).toBe('fresh');
    expect(readDeliveries(f.document.view).isEligible(f.inputId)).toBe(false);
  }
  finally {
    await f.close();
  }
});
it('keeps a claimed steer inside the current finite action and grants no raw alias action', async () => {
  const f = await ownedDeliveryHistory();
  try {
    committedFactSeqs(await f.action.captureGeneration([open(0, 'human-action', { kind: 'input', seq: 0 })], () => true).admit());
    committedFactSeqs(await f.action.facts.inputs.claim({ type: 'agent/input/promoted', version: 1, inputId: f.inputId }, { type: 'user/message', text: f.admitted.text, input: { inputId: f.inputId, intent: 'system', synthetic: f.admitted.synthetic }, provenance: f.admitted.provenance }));
    const raw = f.document.view.events.at(-1)!;
    expect(await f.action.captureGeneration([open(0, 'forged-extra', { kind: 'input', seq: raw.seq! })], () => true).admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' });
    expect(readGenerationActions(f.document.view.events, { sessionId: 'parent' }, 13).map(a => a.opened.actionId)).toEqual(['human-action']);
  }
  finally {
    await f.close();
  }
});
it('retires only a native never-issued stale receipt while preserving its immutable failure and later closed checks', async () => {
  const f = await ownedDeliveryHistory(false);
  try {
    const append = f.backend.appendOwnedBatch!.bind(f.backend), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.backend.appendOwnedBatch = async (...args) => {
      if (JSON.parse(Buffer.from(args[3].bytes).toString()).events.some((e: {
        type: string;
      }) => e.type === 'agent/delivery-received')) {
        entered.resolve();
        await release.promise;
      } return append(...args);
    };
    const captured = f.received.captureDeliveryAdmission(f.receipt, f.admitted, () => true), pending = captured.admit();
    await entered.promise;
    const close = f.received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'crossed-stop', reason: 'user-stop' });
    release.resolve();
    const stale = await pending;
    expect(stale).toMatchObject({ kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' });
    expect(Object.isFrozen(stale)).toBe(true);
    committedFactSeqs(await close.admit());
    await f.received.close();
    expect(f.document.view.events.some(e => e.type === 'agent/delivery-received')).toBe(false);
    for (const operation of [captured.admit, captured.observe, captured.reconcile, captured.retryAbsent])
      await expect(operation()).rejects.toMatchObject({ code: 'FACT_CLOSED' });
  }
  finally {
    await f.close();
  }
});
it('retains original issued-unknown receipt debt through Stop and settles only its original key', async () => {
  const f = await ownedDeliveryHistory(false);
  try {
    const append = f.backend.appendOwnedBatch!.bind(f.backend), reconcile = f.backend.reconcileOwnedBatch!.bind(f.backend);
    let receiptWrites = 0, unknown = true;
    f.backend.appendOwnedBatch = async (...args) => {
      const result = await append(...args); if (JSON.parse(Buffer.from(args[3].bytes).toString()).events.some((e: {
        type: string;
      }) => e.type === 'agent/delivery-received')) {
        receiptWrites++;
        throw Error('lost receipt after sync');
      } return result;
    };
    f.backend.reconcileOwnedBatch = async (...args) => unknown ? { kind: 'unknown', key: args[3].key } : reconcile(...args);
    const captured = f.received.captureDeliveryAdmission(f.receipt, f.admitted, () => true), first = await captured.admit();
    expect(first.kind).toBe('unknown');
    const close = f.received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'unknown-stop', reason: 'user-stop' });
    await expect(f.received.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' });
    expect(await captured.observe()).toEqual(first);
    expect(receiptWrites).toBe(1);
    unknown = false;
    const committed = await captured.reconcile();
    expect(committed.kind).toBe('committed');
    if (first.kind === 'unknown' && committed.kind === 'committed')
      expect(committed.receipt.key).toEqual(first.key);
    committedFactSeqs(await close.admit());
    expect(readDeliveries(f.document.view).receipt(f.key)?.disposition).toBe('suppressed');
    expect(receiptWrites).toBe(1);
  }
  finally {
    await f.close();
  }
});
it.each(['absent', 'conflict'] as const)('never retires a receipt with original %s history as a later stale no-issue result', async (disposition) => {
  const f = await ownedDeliveryHistory(false);
  let recovered = false;
  try {
    const append = f.backend.appendOwnedBatch!.bind(f.backend), reconcile = f.backend.reconcileOwnedBatch!.bind(f.backend);
    f.backend.appendOwnedBatch = async (...args) => {
      if (JSON.parse(Buffer.from(args[3].bytes).toString()).events.some((e: {
        type: string;
      }) => e.type === 'agent/delivery-received')) {
        args[1].beforeIssue();
        return { kind: disposition, key: args[3].key };
      } return append(...args);
    };
    const captured = f.received.captureDeliveryAdmission(f.receipt, f.admitted, () => true), first = await captured.admit();
    expect(first.kind).toBe(disposition);
    if (disposition === 'conflict') {
      f.backend.reconcileOwnedBatch = async (...args) => ({ kind: 'conflict', key: args[3].key });
      await expect(f.received.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' });
      expect(await captured.observe()).toEqual(first);
      // Real backend proves the original frame absent; only explicit same-capture retry may write.
      f.backend.reconcileOwnedBatch = reconcile;
      expect((await captured.reconcile()).kind).toBe('absent');
    }
    const close = f.received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'after-absence', reason: 'user-stop' });
    const stale = await captured.retryAbsent();
    expect(stale).toMatchObject({ kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' });
    committedFactSeqs(await close.admit());
    await expect(f.received.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' });
    expect(await captured.observe()).toBe(stale);
    recovered = true;
  }
  finally {
    if (recovered) {
      await f.coordinator.close().catch(() => { });
      await rm(f.root, { recursive: true, force: true });
    }
    else
      await f.close();
  }
});
it('keeps physically committed installation debt and reconciles the exact original receipt after Stop', async () => {
  const f = await ownedDeliveryHistory(false);
  try {
    const {readOwnedDeliveryState}=await import('../../core-session/src/managed/view.ts'),observed=readOwnedDeliveryState(f.document.view)!;
    expect(observed.input(f.inputId)).toBeUndefined();
    installCut.enabled = true;
    const captured = f.received.captureDeliveryAdmission(f.receipt, f.admitted, () => true), outcome = await captured.admit();
    expect(outcome.kind).toBe('recovery-required');
    expect(observed.input(f.inputId)).toBeUndefined();expect(observed.receipt(f.key)).toBeUndefined();
    expect(f.document.view.events.some(e => e.type === 'agent/delivery-received')).toBe(false);
    expect((await f.backend.read('parent')).events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1);
    const close = f.received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'install-stop', reason: 'user-stop' });
    const recovered = await captured.reconcile();
    expect(recovered.kind).toBe('committed');
    expect(observed.input(f.inputId)?.kind).toBe('delivery');expect(observed.receipt(f.key)?.disposition).toBe('pending');
    expect(new AsyncInbox(f.document.view,()=>f.action.facts.inputs).isPending(f.inputId)).toBe(false);
    if (outcome.kind === 'recovery-required' && recovered.kind === 'committed')
      expect(recovered.receipt.key).toEqual(outcome.receipt.key);
    committedFactSeqs(await close.admit());
    expect(readDeliveries(f.document.view).receipt(f.key)?.disposition).toBe('suppressed');
    expect(observed.receipt(f.key)?.disposition).toBe('suppressed');
  }
  finally {
    installCut.enabled = false;
    await f.close();
  }
});
it('does not retire a synthetic handle fallback before the original native admission is observed', async () => {
  const f = await ownedDeliveryHistory(false);
  try {
    const captured = f.received.captureDeliveryAdmission(f.receipt, f.admitted, () => true);
    expect(await captured.observe()).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' });
    expect(await captured.retryAbsent()).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' });
    expect(f.document.view.events.some(e => e.type === 'agent/delivery-received')).toBe(false);
    await f.received.close();
    expect(f.document.view.events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1);
  }
  finally {
    await f.close();
  }
});
it('retains an original close with unknown acknowledgment and admits new generation only after its exact reconciliation', async () => {
  const f = await ownedDeliveryHistory();
  try {
    const append = f.backend.appendOwnedBatch!.bind(f.backend);
    let closeWrites = 0;
    f.backend.appendOwnedBatch = async (...args) => {
      const result = await append(...args); if (JSON.parse(Buffer.from(args[3].bytes).toString()).events.some((e: {
        type: string;
        op?: string;
      }) => e.type === 'agent/delivery-generation' && e.op === 'close')) {
        closeWrites++;
        throw Error('close ack lost');
      } return result;
    };
    const close = f.received.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'physical-stop', reason: 'user-stop' }), outcome = await close.admit();
    expect(outcome.kind).toBe('unknown');
    expect(new AsyncInbox(f.document.view, () => f.action.facts.inputs).isPending(f.inputId)).toBe(false);
    const settled = await close.reconcile();
    expect(settled.kind).toBe('committed');
    if (outcome.kind === 'unknown' && settled.kind === 'committed')
      expect(settled.receipt.key).toEqual(outcome.key);
    expect(closeWrites).toBe(1);
    const [human] = committedFactSeqs(await f.received.captureAdmitted({ type: 'agent/input/admitted', version: 1, inputId: 'human-after', text: 'new', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }).admit());
    committedFactSeqs(await f.received.captureDeliveryOpen({ type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'after-physical', originInputSeq: human! }, () => true).admit());
    expect(readDeliveries(f.document.view).isEligible(f.inputId)).toBe(false);
  }
  finally {
    await f.close();
  }
});
it('refuses a postpromotion delivery action after an intervening other main action in that same turn', async () => {
  const f = await ownedDeliveryHistory();
  try {
    committedFactSeqs(await f.action.facts.inputs.start({ type: 'agent/input/promoted', version: 1, inputId: f.inputId }, { type: 'user/message', text: f.admitted.text, input: { inputId: f.inputId, intent: 'system', synthetic: f.admitted.synthetic }, provenance: f.admitted.provenance }));
    const raw = f.document.view.events.at(-1)!;
    committedFactSeqs(await f.action.captureGeneration([open(0, 'intervening', { kind: 'input', seq: 0 })], () => true).admit());
    expect(await f.action.captureGeneration([open(0, 'late-delivery', { kind: 'input', seq: raw.seq! })], () => true).admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' });
  }
  finally {
    await f.close();
  }
});
it('replays internally consistent explicit own human origin without a header session id and rejects foreign provenance', async () => {
  const f = await ownedDeliveryHistory();
  try {
    const events = JSON.parse(JSON.stringify(f.document.view.events)) as SessionEvent[], human = events[0]!;
    if (human.type !== 'agent/input/admitted')
      throw Error('fixture');
    human.provenance!.originSessionId = 'parent';
    expect(() => readDeliveries({ formatVersion: 13, events })).not.toThrow();
    human.provenance!.originSessionId = 'foreign';
    expect(() => readDeliveries({ formatVersion: 13, events })).toThrow();
  }
  finally {
    await f.close();
  }
});
it('protects required delivery scalar records and pending original source dependencies in conversation state', async () => {
  const f = await ownedDeliveryHistory(); try {
    const { projectConversation, readConversationState } = await import('@i-harness/core-session'); const state = readConversationState(f.document.view, projectConversation(f.document.view))
    expect(state.kind).toBe('available'); if (state.kind !== 'available') throw Error('fixture')
    const protectedSeqs = state.state.sourceIds.map(id => JSON.parse(id)[1]); expect(protectedSeqs).toContain(f.sourceSeq); expect(protectedSeqs).toContain(f.terminalSeq)
  } finally { await f.close() }
})
it('keeps receipt disposition monotone when presentation is shadowed and rewind fences raw pending', async () => {
const f = await ownedDeliveryHistory(); try {
    const admitted = f.document.view.events.find(e => e.type === 'agent/input/admitted' && e.inputId === f.inputId)!
    committedFactSeqs(await f.action.facts.compaction.commit([{ type: 'compaction/reset', removedSeqs: [f.sourceSeq, f.terminalSeq, admitted.seq!] }]))
    expect(readDeliveries(f.document.view).isEligible(f.inputId)).toBe(true)
    committedFactSeqs(await f.action.facts.compaction.commit([{ type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 0, mode: 'conversation', fileOps: [] }]))
    expect(readDeliveries(f.document.view).receipt(f.key)?.disposition).toBe('suppressed'); expect(readInbox(f.document.view).isPending(f.inputId)).toBe(true)
    expect(new AsyncInbox(f.document.view, () => f.action.facts.inputs).isPending(f.inputId)).toBe(false)
  } finally { await f.close() }
})
it.each(['before','after'] as const)('checks a new finite delivery action at the actual backend issue boundary (%s promotion)',async order=>{const f=await ownedDeliveryHistory();try{
 const admission=f.document.view.events.find(e=>e.type==='agent/input/admitted'&&e.inputId===f.inputId)!
 if(order==='after')committedFactSeqs(await f.action.facts.inputs.start({type:'agent/input/promoted',version:1,inputId:f.inputId},{type:'user/message',text:f.admitted.text,input:{inputId:f.inputId,intent:'system',synthetic:f.admitted.synthetic},provenance:f.admitted.provenance}))
 const raw=f.document.view.events.at(-1)!,append=f.backend.appendOwnedBatch!.bind(f.backend),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 f.backend.appendOwnedBatch=async(...args)=>{if(JSON.parse(Buffer.from(args[3].bytes).toString()).events.some((e:{type:string;op?:string})=>e.type==='context/action'&&e.op==='open')){entered.resolve();await release.promise}return append(...args)}
 const fact=f.action.captureGeneration([open(0,'crossed-action',order==='before'?{kind:'observation-input',seq:admission.seq!,inputId:f.inputId}:{kind:'input',seq:raw.seq!})],()=>true),pending=fact.admit()
 await entered.promise
 const close=f.received.captureDeliveryClose({type:'agent/delivery-generation',version:1,op:'close',recipientSessionId:'parent',fenceId:'action-stop',reason:'user-stop'})
 release.resolve();expect(await pending).toMatchObject({kind:'not-issued',code:'FACT_PRECONDITION_STALE'});committedFactSeqs(await close.admit());expect(readGenerationActions(f.document.view.events,{sessionId:'parent'},13)).toEqual([])
}finally{await f.close()}})
it.each(['synthetic-human','inherited-human','wrong-spawn','undispatched','cancelled-terminal','unavailable-result','wrong-generation'] as const)('rejects a real owned history with %s authority mutation',async mode=>{const f=await ownedDeliveryHistory();try{
 const events=JSON.parse(JSON.stringify(f.document.view.events)) as SessionEvent[],human=events[0]!,source=events[f.sourceSeq]!,terminal=events[f.terminalSeq]!
 if(human.type!=='agent/input/admitted'||source.type!=='agent/delivery-source'||terminal.type!=='subagent/end')throw Error('fixture')
 if(mode==='synthetic-human')human.synthetic={scope:'turn',description:'not human'}
 if(mode==='inherited-human')human.provenance={kind:'inherited',authority:'observation',scope:'turn',producer:'subagent.initial',originSessionId:'other'}
 if(mode==='wrong-spawn'){const call=events[source.callSeq]!;if(call.type==='tool/call')call.name='other'}
 if(mode==='undispatched'){const dispatch=events.find(e=>e.type==='tool/dispatch')!;if(dispatch.type==='tool/dispatch')dispatch.eventSeq=0}
 if(mode==='cancelled-terminal')terminal.outcome='cancelled'
 if(mode==='unavailable-result')terminal.envelope!.retention={kind:'unavailable',reason:'storage-refused'}
 if(mode==='wrong-generation')source.generationId='foreign'
 expect(()=>createManagedSessionState({formatVersion:13,events},{sessionId:'parent'})).toThrow()
}finally{await f.close()}})
it.each([null,false,0,''] as const)('rejects supplied malformed binding %s rather than silently lowering an unbound start',async binding=>{const f=await ownedDeliveryHistory();try{
 expect(await f.action.captureSubagentStart({type:'subagent/start',version:1,taskId:'second',parentSessionId:'parent',agentPath:'a',role:'worker',description:'invalid binding'},binding as never).admit()).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'})
 await expect(f.document.close()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
}finally{await f.coordinator.close().catch(()=>{});await rm(f.root,{recursive:true,force:true})}})
it('refuses a close DTO through the open-only required source capture',async()=>{const f=await ownedDeliveryHistory();try{
 const wrong=f.received.captureDeliveryOpen({type:'agent/delivery-generation',version:1,op:'close',recipientSessionId:'parent',fenceId:'misrouted',reason:'user-stop'} as never,()=>true)
 expect(await wrong.admit()).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'})
 await expect(f.received.close()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
}finally{await f.coordinator.close().catch(()=>{});await rm(f.root,{recursive:true,force:true})}})
it('refuses an open DTO through the close-only port without issuing or revoking a valid original input',async()=>{const f=await ownedDeliveryHistory();try{
 const before=f.document.view.events.length,wrong=f.received.captureDeliveryClose({type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:'parent',generationId:'misrouted',originInputSeq:0} as never)
 expect(await wrong.admit()).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'});expect(f.document.view.events).toHaveLength(before)
 expect(new AsyncInbox(f.document.view,()=>f.action.facts.inputs).isPending(f.inputId)).toBe(true)
 await expect(f.received.close()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
}finally{await f.coordinator.close().catch(()=>{});await rm(f.root,{recursive:true,force:true})}})
it('retains strict owned terminal envelope validation when semantic-source payload checks are deferred',async()=>{const f=await ownedDeliveryHistory();try{
 const {readFile}=await import('node:fs/promises'),path=join(f.root,'parent.jsonl'),before=await readFile(path),source=f.action.registerSettlementSource(async()=>{})
 const invalid=source.delivery.capture({type:'subagent/end',version:1,taskId:'invalid-original',outcome:'completed',resultRevision:'invalid-original',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'',media:[],retention:{kind:'inline',value:'opaque',encodedBytes:99}}})
 expect(await invalid.admit()).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'})
 expect(await readFile(path)).toEqual(before);expect(f.document.view.events.some(event=>event.type==='subagent/end'&&event.taskId==='invalid-original')).toBe(false)
 await expect(source.close()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
}finally{await f.coordinator.close().catch(()=>{});await rm(f.root,{recursive:true,force:true})}})
it('discards receipt disposition, promotion, raw-start and origin writes from a rejected delivery stage',async()=>{const f=await ownedDeliveryHistory();try{
 const {createDeliveryIndex}=await import('../../core-session/src/conversation/delivery.ts'),index=createDeliveryIndex({sessionId:'parent'}),prefix=index.stage()
 for(const event of f.document.view.events)prefix.advance(event)
 prefix.validate();prefix.commit()
 const count=f.document.view.events.length,admission=f.document.view.events.find(e=>e.type==='agent/input/admitted'&&e.inputId===f.inputId)!,before=index.read().receipt(f.key),abandoned=index.stage()
 abandoned.advance({type:'agent/input/promoted',version:1,inputId:f.inputId,seq:count})
 abandoned.advance({type:'turn/start',seq:count+1})
 abandoned.advance({type:'user/message',text:f.admitted.text,input:{inputId:f.inputId,intent:'system',synthetic:f.admitted.synthetic},provenance:f.admitted.provenance,seq:count+2})
 abandoned.advance(open(count+3,'abandoned',{kind:'input',seq:count+2}))
 expect(()=>abandoned.advance({...f.receipt,seq:count+4})).toThrow(/duplicate delivery receipt/)
 expect(index.read().receipt(f.key)).toEqual(before);expect(index.read().isEligible(f.inputId)).toBe(true)
 const kept=index.stage(),original=open(count,'kept',{kind:'observation-input',seq:admission.seq!,inputId:f.inputId})
 expect(kept.lookupActionOrigin(original)).toEqual({receiptSeq:f.document.view.events.find(e=>e.type==='agent/delivery-received')!.seq!,admissionSeq:admission.seq!,inputId:f.inputId,actionId:'kept',openedSeq:count})
 kept.advance(original)
 kept.advance({type:'agent/input/promoted',version:1,inputId:f.inputId,seq:count+1});kept.advance({type:'turn/start',seq:count+2})
 kept.advance({type:'user/message',text:f.admitted.text,input:{inputId:f.inputId,intent:'system',synthetic:f.admitted.synthetic},provenance:f.admitted.provenance,seq:count+3})
 kept.validate();kept.commit();expect(index.read().receipt(f.key)?.disposition).toBe('claimed')
}finally{await f.close()}})
it.each([32,64])('ordinary actual managed appends do not replay delivery history (%s frames)',async count=>{
 const root=await mkdtemp(join(tmpdir(),'delivery-append-count-')),backend=createJsonlBackend(root),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}})
 try{
  await coordinator.create({sessionId:'ordinary'});const document=await coordinator.openManagedDocument('ordinary'),action=document.beginAction()
  deliveryReads.replays=0;deliveryReads.prefixEvents=0;deliveryReads.enabled=true
  try{for(let seq=0;seq<count;seq++)committedFactSeqs(await action.facts.metadata.admit({type:'plan/mode',mode:'off'}))}finally{deliveryReads.enabled=false}
  const measured={frames:count,replays:deliveryReads.replays,prefixEvents:deliveryReads.prefixEvents};console.log(JSON.stringify({control:'actual managed delivery replay counts',...measured}))
  expect(document.view.events).toHaveLength(count);expect(measured.replays).toBe(0);expect(measured.prefixEvents).toBe(0);action.finish()
 }finally{deliveryReads.enabled=false;await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('observes managed Inbox delivery eligibility once using the original index and scalar input lookups',async()=>{const f=await ownedDeliveryHistory();try{
 for(let n=0;n<32;n++)committedFactSeqs(await f.received.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'ordinary-'+n,text:'ordinary',intent:'user',delivery:'queue'}).admit())
 const some=Object.getOwnPropertyDescriptor(Array.prototype,'some')!,findLast=Object.getOwnPropertyDescriptor(Array.prototype,'findLast')!;let historySome=0,historyFindLast=0,pending:ReturnType<AsyncInbox['pending']>
 deliveryReads.replays=0;deliveryReads.prefixEvents=0;deliveryReads.enabled=true
 try{
  Object.defineProperty(Array.prototype,'some',{...some,value:function(this:unknown[],...args:unknown[]){if(this===f.document.view.events)historySome++;return some.value.apply(this,args)}})
  Object.defineProperty(Array.prototype,'findLast',{...findLast,value:function(this:unknown[],...args:unknown[]){if(this===f.document.view.events)historyFindLast++;return findLast.value.apply(this,args)}})
  pending=new AsyncInbox(f.document.view,()=>f.action.facts.inputs).pending()
 }finally{deliveryReads.enabled=false;Object.defineProperty(Array.prototype,'some',some);Object.defineProperty(Array.prototype,'findLast',findLast)}
 expect(pending!).toHaveLength(34);expect(pending!.some(input=>input.inputId===f.inputId)).toBe(true)
 console.log(JSON.stringify({control:'managed Inbox delivery observation',pending:pending!.length,historySome,historyFindLast,replays:deliveryReads.replays,prefixEvents:deliveryReads.prefixEvents}))
 expect(historySome).toBe(1);expect(historyFindLast).toBe(0);expect(deliveryReads.replays).toBe(0)
}finally{await f.close()}})
it('publishes the original delivery read facade only with the validated synchronous install',async()=>{const f=await ownedDeliveryHistory();try{
 const {readOwnedDeliveryState}=await import('../../core-session/src/managed/view.ts')
 expect(readOwnedDeliveryState(Object.freeze({...f.document.view}))).toBeUndefined()
 const local=createManagedSessionState({formatVersion:13,events:JSON.parse(JSON.stringify(f.document.view.events))},{sessionId:'parent'}),observed=readOwnedDeliveryState(local.view)!,count=local.view.events.length
 expect(observed.receipt(f.key)?.disposition).toBe('pending')
 const group=(seq:number):SessionEvent[]=>[{type:'agent/input/promoted',version:1,inputId:f.inputId,seq},{type:'turn/start',seq:seq+1},{type:'user/message',text:f.admitted.text,input:{inputId:f.inputId,intent:'system',synthetic:f.admitted.synthetic},provenance:f.admitted.provenance,seq:seq+2}]
 const staged=local.stage(group(count))
 expect(observed.receipt(f.key)?.disposition).toBe('pending');expect(local.view.events).toHaveLength(count)
 local.stage([{type:'plan/mode',mode:'off',seq:count}]).install()
 expect(()=>staged.install()).toThrow(/stale staged suffix/)
 expect(observed.receipt(f.key)?.disposition).toBe('pending');expect(observed.isEligible(f.inputId)).toBe(true)
 local.stage(group(count+1)).install()
 expect(observed.receipt(f.key)?.disposition).toBe('claimed');expect(observed.isEligible(f.inputId)).toBe(false)
}finally{await f.close()}})
it('refuses same-length mutable memory terminal tampering instead of trusting its warmed original cache',async()=>{const f=await ownedDeliveryHistory();try{
 const {createNondurableFactOwner}=await import('@i-harness/core-session'),{readOwnedDeliveryState}=await import('../../core-session/src/managed/view.ts')
 const memory={formatVersion:13,events:JSON.parse(JSON.stringify(f.document.view.events)) as SessionEvent[]},owner=createNondurableFactOwner(memory),action=owner.beginAction()
 committedFactSeqs(await action.facts.metadata.admit({type:'plan/mode',mode:'off'}))
 const inbox=new AsyncInbox(memory,()=>action.facts.inputs),terminal=memory.events[f.terminalSeq]!
 expect(readOwnedDeliveryState(memory)).toBeUndefined();expect(inbox.isPending(f.inputId)).toBe(true)
 if(terminal.type!=='subagent/end')throw Error('fixture')
 const before=memory.events.length,revision=terminal.resultRevision;terminal.resultRevision='tampered-same-length'
 expect(()=>inbox.pending()).toThrow(/unqualified/)
 await expect(action.facts.inputs.claim({type:'agent/input/promoted',version:1,inputId:f.inputId},{type:'user/message',text:f.admitted.text,input:{inputId:f.inputId,intent:'system'}})).rejects.toThrow(/unqualified/)
 expect(memory.events).toHaveLength(before)
 terminal.resultRevision=revision;expect(inbox.isPending(f.inputId)).toBe(true)
 const received=owner.registerReceivedInputSource(async()=>{}),close=received.captureDeliveryClose({type:'agent/delivery-generation',version:1,op:'close',recipientSessionId:'parent',fenceId:'memory-stop',reason:'user-stop'})
 expect(inbox.isPending(f.inputId)).toBe(false);committedFactSeqs(await close.admit());await received.close();action.finish()
}finally{await f.close()}})
it('indexes current admission class without changing legacy task suppression, team/schedule or raw cancellation reuse',async()=>{const f=await ownedDeliveryHistory();try{
 const input=(inputId:string,kind:'task'|'team-result'|'schedule')=>({type:'agent/input/admitted',version:1,inputId,text:'report',delivery:'steer',intent:'system',provenance:{kind:kind==='schedule'?'plugin':'child-report',authority:'observation',scope:'turn',producer:kind==='schedule'?'session.schedule':'session.notification'},synthetic:{description:'report',scope:'turn',display:{kind,title:'report',body:'report'}}} as const)
 for(const [id,kind]of [['legacy','task'],['team','team-result'],['schedule','schedule']] as const)committedFactSeqs(await f.received.captureAdmitted(input(id,kind)).admit())
 const inbox=new AsyncInbox(f.document.view,()=>f.action.facts.inputs)
 expect(inbox.isPending('legacy')).toBe(false);expect(readInbox(f.document.view).isPending('legacy')).toBe(true)
 expect(inbox.isPending('team')).toBe(true);expect(inbox.isPending('schedule')).toBe(true)
 expect(await inbox.cancel('legacy')).toBe(true)
 committedFactSeqs(await f.received.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'legacy',text:'new human input',intent:'user',delivery:'queue'}).admit())
 expect(inbox.isPending('legacy')).toBe(true)
}finally{await f.close()}})
