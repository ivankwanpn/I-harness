import { expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { committedFactSeqs, deliveryInputId, readFactJournal, encodeFactBatch, decodeFactBatch, legacyPrefixDigest } from '@i-harness/core-session';
import { createSessionCoordinator } from '@i-harness/session-persistence';
import { createJsonlBackend } from '../src/index.ts';
async function ownedDeliveryHistory() {
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
  committedFactSeqs(await received.captureDeliveryAdmission(receipt, admitted, () => true).admit());
  return { coordinator, backend, document, root, sourceSeq, terminalSeq: terminalSeq!, inputId, received, action, admitted, receipt, key, async close() { await terminal.close(); action.finish(); await received.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }); } };
}
it.each(['source', 'receipt'] as const)('rejects a split complete physical %s pair before installation', async (kind) => {
  const f = await ownedDeliveryHistory();
  try {
    const raw = await readFile(join(f.root, 'parent.jsonl'), 'utf8'), lines = raw.trimEnd().split('\n'), header = JSON.parse(lines[0]!), frames = lines.slice(1).map(line => decodeFactBatch(Buffer.from(line + '\n')));
    let digest = header.journal.legacyPrefixDigest;
    const chunks: Buffer[] = [];
    for (const [i, frame] of frames.entries()) {
      const target = frame.events.some(e => e.type === (kind === 'source' ? 'agent/delivery-source' : 'agent/delivery-received'));
      const groups = target ? frame.events.map(e => [e]) : [frame.events];
      for (const [j, events] of groups.entries()) {
        const encoded = encodeFactBatch('split-' + i + '-' + j, digest, events);
        chunks.push(Buffer.from(encoded.bytes));
        digest = decodeFactBatch(encoded.bytes).prefixDigest;
      }
    }
    expect(() => readFactJournal(Buffer.concat(chunks), header.journal, 13, { sessionId: 'parent' })).toThrow(/same-frame/);
  }
  finally {
    await f.close();
  }
});
it('installs neither member of a torn final receipt frame and preserves original terminal proof', async () => {
  const f = await ownedDeliveryHistory();
  try {
    const raw = await readFile(join(f.root, 'parent.jsonl')), end = raw.indexOf(10), header = JSON.parse(raw.subarray(0, end).toString()), body = raw.subarray(end + 1), torn = body.subarray(0, body.length - 20);
    const decoded = readFactJournal(torn, header.journal, 13, { sessionId: 'parent' });
    expect(decoded.torn).toBe(true);
    expect(decoded.events.some(e => e.type === 'agent/delivery-received')).toBe(false);
    expect(decoded.events.some(e => e.type === 'agent/input/admitted' && e.inputId === f.inputId)).toBe(false);
    expect(decoded.events.at(-1)).toMatchObject({ type: 'subagent/end', resultRevision: 'original-revision' });
  }
  finally {
    await f.close();
  }
});
it('rejects delivery authority moved into a validly hashed unframed legacy prefix', async () => {
  const f = await ownedDeliveryHistory();
  try {
    const events = f.document.view.events, body = Buffer.from(events.map(e => JSON.stringify(e) + '\n').join('')), journal = { version: 1 as const, legacyBodyBytes: body.length, legacyEventCount: events.length, legacyPrefixDigest: legacyPrefixDigest(events.length, body), separatorBytes: 0 as const };
    expect(() => readFactJournal(body, journal, 13, { sessionId: 'parent' })).toThrow();
  }
  finally {
    await f.close();
  }
});
it('refuses direct upgrade of a downgraded required delivery body before changing its header', async () => {
const f = await ownedDeliveryHistory(); try {
    const { writeFile } = await import('node:fs/promises'), path = join(f.root, 'parent.jsonl'), raw = await readFile(path), end = raw.indexOf(10), header = JSON.parse(raw.subarray(0, end).toString())
    const downgraded = Buffer.concat([Buffer.from(JSON.stringify({ ...header, formatVersion: 12 }) + '\n'), raw.subarray(end + 1)]); await writeFile(path, downgraded)
    await expect(f.backend.upgradeSessionFormat!('parent', 12, 13)).rejects.toThrow()
    expect(await readFile(path)).toEqual(downgraded)
    await writeFile(path, raw)
  } finally { await f.close() }
})
