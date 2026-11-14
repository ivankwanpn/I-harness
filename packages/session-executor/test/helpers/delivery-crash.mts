import assert from 'node:assert/strict'
import { open, readFile, writeFile, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { setImmediate as turn } from 'node:timers/promises'
import { join } from 'node:path'
import { decodeFactBatch, subscribe } from '@i-harness/core-session'
import { composeJsonlTaskTransitionCoordinator } from '../../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { createOpenAICompatibleClient } from '../../../llm-openai-compatible/src/index.ts'
import { createSessionService, createDurableSessionLoader, createUnmanagedTaskChildHost } from '../../src/index.ts'

// All cuts retain the actual original source/result/recipient and physical
// roots. Only physical backend boundaries are fault controlled.
const [root, endpoint, nonce, mode = 'before-first-receipt'] = process.argv.slice(2)
assert(root && endpoint && nonce && process.env.IH_CONFIG_DIR)
type OwnedAppend = NonNullable<ReturnType<typeof createJsonlBackend>['appendOwnedBatch']>
type OwnedReconcile = NonNullable<ReturnType<typeof createJsonlBackend>['reconcileOwnedBatch']>
let append: OwnedAppend, reconcile: OwnedReconcile
let issuedEnd = 0, cutStarted = false
let unknownKey: import('@i-harness/core-session').BatchKey | undefined
const trace: unknown[] = []
// The writer cut observes committed native ACKs and the original document file.
// Public managed reads are fenced while this append is awaiting its result.
const parentFacts: ReturnType<typeof decodeFactBatch>['events'][number][] = []
const backend = createJsonlBackend(join(root, 'sessions'), {
  wrapOwnedBatch(original) { append = original; return appendWithCuts },
  wrapOwnedReconcile(original) { reconcile = original; return reconcileWithCuts },
})
const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
await coordinator.create({ sessionId: 'parent' })
const document = await coordinator.openManagedDocument('parent')
const output = createContextOutputService({ root: join(root, 'results'), workspaceId: 'd1a-crash', config: { enabled: false } })
const parent = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'parent', baseUrl: endpoint })
const child = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'child', baseUrl: endpoint })
async function cut(phase: string, detail: object = {}) {
  if (cutStarted) return new Promise<never>(() => {})
  cutStarted = true
  // The original strict save runs concurrently with the end append. Observe
  // that original owner; never save a replacement descriptor to help a cut.
  let taskDocument: import('@i-harness/subagent').TaskProtocolDocument | undefined
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    taskDocument = await backend.getDocument('task-parent') as typeof taskDocument
    if (taskDocument?.tasks.some(t => t.result?.kind === 'retained')) break
    await turn()
  }
  const binding = parentFacts.find(e => e.type === 'agent/delivery-source')
  const terminal = parentFacts.findLast(e => e.type === 'subagent/end')
  const task = taskDocument?.tasks.find(t => t.id === (binding?.type === 'agent/delivery-source' ? binding.sourceId : ''))
  assert(binding?.type === 'agent/delivery-source')
  assert(task?.result?.kind === 'retained' && task.result.envelope.retention.kind === 'artifact')
  const raw = await readFile(join(root, 'sessions', 'parent.jsonl'))
  const record = { nonce, producerPid: process.pid, kind: mode, phase, root, binding, terminal, taskDocument, issuedEnd, trace, journalBase64: raw.toString('base64'), journalSha256: createHash('sha256').update(raw).digest('hex'), ...detail,
    cleanup: 'process cut: original live owners deliberately not disposed' }
  await writeFile(join(root, 'cut.json'), JSON.stringify(record, null, 2))
  await new Promise<void>((resolve, reject) => process.send!(record, error => error ? reject(error) : resolve()))
  process.exit(0)
}
async function appendWithCuts(...args: Parameters<OwnedAppend>): ReturnType<OwnedAppend> {
  const events = decodeFactBatch(args[3].bytes).events
  if (args[0] !== 'parent') return append(...args)
  trace.push({ phase: 'prepared', key: args[3].key, types: events.map(e => e.type) })
  if (events.some(e => e.type === 'subagent/end')) {
    if (mode === 'end-never-issued') await cut('original-end-before-issuance', { originalEnd: events.find(e => e.type === 'subagent/end'), key: args[3].key })
    if (mode === 'end-absent-issued') {
      // Exercise the actual writer's issued→zero progress→truncate+sync→absent
      // branch. The fault matches only this original batch buffer in this
      // owned child process, and delegates a real zero-byte native write.
      const probe = await open(join(root, 'sessions', 'parent.jsonl'), 'r+')
      const prototype = Object.getPrototypeOf(probe), write = prototype.write
      await probe.close()
      let originalWriteAttempts = 0
      prototype.write = function (this: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number) {
        if (bytes === args[3].bytes) { originalWriteAttempts++; return write.call(this, bytes, offset, 0, position) }
        return write.call(this, bytes, offset, length, position)
      }
      let outcome
      try { outcome = await append(...args) } finally { prototype.write = write }
      assert(outcome.kind === 'absent'); assert.equal(originalWriteAttempts, 1); issuedEnd++
      trace.push({ phase: 'returned', key: args[3].key, outcome })
      await cut('original-end-native-confirmed-absent', { originalEnd: events.find(e => e.type === 'subagent/end'), key: args[3].key, originalWriteAttempts, observedOutcome: outcome })
    }
    if (mode === 'end-torn' || mode === 'end-conflicted') {
      args[1].assertHeld(); args[1].beforeIssue(); issuedEnd++
      const handle = await open(join(root, 'sessions', 'parent.jsonl'), 'r+')
      try {
        const raw = await readFile(join(root, 'sessions', 'parent.jsonl')), offset = raw.indexOf(10) + 1 + args[2].bodyBytes
        const bytes = Buffer.from(args[3].bytes)
        if (mode === 'end-conflicted') bytes[10] = bytes[10] === 65 ? 66 : 65
        const fragment = mode === 'end-torn' ? bytes.subarray(0, Math.floor(bytes.length / 2)) : bytes
        await handle.write(fragment, 0, fragment.length, offset); await handle.sync()
      } finally { await handle.close() }
      await cut('original-end-physical-fault', { originalEnd: events.find(e => e.type === 'subagent/end'), key: args[3].key })
    }
  }
  if (args[0] === 'parent' && events.some(e => e.type === 'agent/delivery-received')) {
    const terminal = parentFacts.findLast(e => e.type === 'subagent/end')
    const binding = parentFacts.find(e => e.type === 'agent/delivery-source')
    const taskDocument = await backend.getDocument('task-parent') as import('@i-harness/subagent').TaskProtocolDocument
    assert(terminal?.type === 'subagent/end' && terminal.outcome === 'completed' && terminal.envelope?.retention.kind === 'artifact')
    assert(binding?.type === 'agent/delivery-source')
    const task = taskDocument.tasks.find(t => t.id === terminal.taskId)
    assert(task?.result?.kind === 'retained' && task.result.revision === terminal.resultRevision && task.outcome === 'completed')
    assert(!parentFacts.some(e => e.type === 'agent/delivery-received'))
    if (mode === 'before-first-receipt') await cut('original-end-committed-receipt-unissued', { unissuedReceiptKey: args[3].key })
  }
  if (mode === 'scheduled-before-claim' && events.some(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))) await cut('actual-lane-before-claim-issuance', { key: args[3].key })
  const close = events.some(e => e.type === 'agent/delivery-generation' && e.op === 'close')
  if (close && mode === 'close-before-issue') await cut('requested-close-before-issuance', { key: args[3].key })
  const outcome = await append(...args)
  trace.push({ phase: 'returned', key: args[3].key, outcome })
  if (outcome.kind === 'committed') parentFacts.push(...events)
  if (events.some(e => e.type === 'subagent/end')) issuedEnd++
  const selectedUnknown = mode === 'end-landed-unknown' && events.some(e => e.type === 'subagent/end')
    || mode === 'receipt-landed-unknown' && events.some(e => e.type === 'agent/delivery-received')
    || mode === 'claim-landed-unknown' && events.some(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))
    || mode === 'close-landed-unknown' && close
  if (selectedUnknown) { assert(outcome.kind === 'committed'); unknownKey = args[3].key; return { kind: 'unknown', key: args[3].key } }
  if (mode === 'receipt-before-source-ack' && events.some(e => e.type === 'agent/delivery-received')) await cut('receipt-durable-before-source-ack', { key: args[3].key })
  return outcome
}
async function reconcileWithCuts(...args: Parameters<OwnedReconcile>): ReturnType<OwnedReconcile> {
  if (args[3].key.batchId === unknownKey?.batchId) await cut('original-capture-observed-unknown', { key: args[3].key, observedOutcome: { kind: 'unknown', key: args[3].key } })
  return reconcile(...args)
}
subscribe(document.view, event => {
  if (['close-before-issue', 'close-landed-unknown', 'close-confirmed'].includes(mode) && event.type === 'agent/delivery-received') service.cancelRunning!('parent')
  if (mode === 'close-confirmed' && event.type === 'agent/delivery-generation' && event.op === 'close') void cut('original-close-installed', { close: event })
})
const service = createSessionService({ workspace: root, coordinator, prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: 'unmanaged' }), sessionFor: createDurableSessionLoader(coordinator), contextOutput: output,
  model: parent, modelPolicy: 'test-mock', approveAll: true, sandbox: 'danger-full-access', codeMode: { mode: 'off' }, contextWindow: 100000,
  pluginAgents: [{ name: 'probe', description: 'delivery crash fixture', systemPrompt: 'Return original child result', tools: [] }],
  allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: 'fixture', model: 'child' }),
  resolveRoleModel: async () => ({ status: 'ready', binding: { client: child, contextWindow: 100000 } }),
})
await service.submit('parent', 'run original ordinary child', new AbortController().signal)
// IPC keeps the original real source alive until the backend cut is reached.
process.on('message', () => {})
