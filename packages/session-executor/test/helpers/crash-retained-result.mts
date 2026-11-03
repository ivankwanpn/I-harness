import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { installPhysicalFault, installStageProbe, installGuestProbe, type Cut, type FaultState } from './retained-crash-faults.mts'
import type { SessionEvent, EncodedFactBatch } from '@i-harness/core-session'
import type { BackendFactOutcome } from '@i-harness/session-persistence'

const [root, id, endpoint, cutArg, modeArg, nonce] = process.argv.slice(2)
if (!root || !id || !endpoint || !cutArg || !modeArg || !nonce || !process.env.IH_CONFIG_DIR) throw new Error('Missing isolated crash fixture arguments')
const cut = cutArg as Cut, mode = modeArg as 'normal' | 'code'
process.on('message', () => {}) // IPC owns liveness while the original operation parks.
const send = (value: object) => new Promise<void>((resolve, reject) => process.send!({ nonce, id, mode, cut, ...value }, error => error ? reject(error) : resolve()))
const park = () => new Promise<never>(() => {})
const fault: FaultState = { armed: false, factories: 0, stages: 0, installs: 0, selectedInstalls: 0, selectedObservations: 0, installOutcomes: [], installThrows: [] }
const core = await installStageProbe(fault)
let guestFulfilled = 0
await installGuestProbe(() => { guestFulfilled++ })
const moduleMappings = { core: import.meta.resolve('@i-harness/core-session'), runtime: import.meta.resolve('../../../code-mode/src/runtime.ts') }
// No persistence/executor runtime import precedes native mock registration.
const { createSessionCoordinator } = await import('@i-harness/session-persistence')
const { createJsonlBackend } = await import('@i-harness/session-persistence-jsonl')
const { createOpenAICompatibleClient } = await import('../../../llm-openai-compatible/src/index.ts')
const { createSessionService } = await import('../../src/index.ts')
const { counters, fixtureTool, observeService, selectedResult, artifactInventory, committedOperation, digest } = await import('./retained-crash-fixture.mts')
const count = counters(), physical = await installPhysicalFault(root), store = join(root, 'sessions')
const nativeFetch = globalThis.fetch
globalThis.fetch = (async (url, init) => {
  if (String(url) !== endpoint + '/v1/chat/completions') throw new Error('Unexpected network destination')
  return nativeFetch(url, init)
}) as typeof fetch
const backend = createJsonlBackend(store), append = backend.appendOwnedBatch!.bind(backend), reconcile = backend.reconcileOwnedBatch!.bind(backend)
let nested: { cellId: string; callId: string; parentCallId?: string } | undefined
let selected: { batch: EncodedFactBatch; result: SessionEvent; outcome?: BackendFactOutcome } | undefined
let issues = 0, receipts = 0, reconciles = 0, observed = 0
fault.target = events => !!selectedResult(events, mode, nested)
const announce = async (kind: string, extra: object = {}) => {
  assert(selected)
  const event = selected.result
  assert((event.type === 'tool/result' || event.type === 'code/result') && event.envelope?.retention.kind === 'artifact')
  const ref = event.envelope.retention.ref
  const inventory = await artifactInventory(root, store), operation = committedOperation(inventory, ref, id)
  count.guestFulfilled = guestFulfilled
  await send({ kind, counters: count, fault, physical: physical.measured, issues, receipts, reconciles, observed, nested,
    key: selected.batch.key, frame: Buffer.from(selected.batch.bytes).toString('base64'), frameDigest: digest(selected.batch.bytes), result: selected.result, ref, operation, inventory, outcome: selected.outcome, moduleMappings, ...extra })
}
backend.reconcileOwnedBatch = async (...args) => {
  if (selected?.batch.key.batchId === args[3].key.batchId) reconciles++
  return reconcile(...args)
}
backend.appendOwnedBatch = async (...args) => {
  const decoded = core.decodeFactBatch(args[3].bytes)
  for (const event of decoded.events) if (event.type === 'code/call' && event.name === 'fixture_result') {
    assert.equal(nested, undefined); nested = { cellId: event.cellId, callId: event.callId, parentCallId: event.parentCallId }
  }
  const result = selectedResult(decoded.events, mode, nested)
  if (!result) return append(...args)
  assert.equal(selected, undefined, 'exactly one original selected batch')
  selected = { batch: args[3], result }
  if (cut === 'before-issue') { await announce('cut'); return park() }
  // Forward the original owner and prefix without reconstructing capabilities.
  physical.arm(args[3], cut)
  const outcome = await append(...args)
  issues = physical.measured.writes; selected.outcome = outcome
  if (outcome.kind === 'committed') receipts++
  if (cut === 'partial-unknown' || cut === 'complete-unknown') {
    assert.equal(outcome.kind, 'unknown'); assert.deepEqual('key' in outcome && outcome.key, args[3].key)
    await announce('cut'); return park() // DO NOT forward unknown into passive source drain.
  }
  assert.equal(outcome.kind, 'committed')
  if (cut === 'receipt-withheld') { await announce('cut'); return park() }
  return outcome
}
const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
await coordinator.create({ sessionId: id })
const document = await coordinator.openManagedDocument(id)
assert(core.isManagedFactOwner(document.view, document), 'shared original view/owner brand')
core.subscribe(document.view, event => { if (selectedResult([event], mode, nested)) observed++ })
const service = createSessionService({ workspace: root, coordinator, contextOutputSettingsPath: join(root, 'config', 'settings.json'),
  approveAll: true, codeMode: { mode: mode === 'code' ? 'only' : 'off' },
  model: createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: endpoint }), additionalTools: [fixtureTool(root, count)] })
observeService(service, count)
fault.armed = cut === 'install'
const submission = await service.submit(id, 'produce the original retained fixture result', new AbortController().signal)
  .then(() => ({ kind: 'resolved' as const }), (error: unknown) => ({ kind: 'rejected' as const, error }))
if (submission.kind === 'resolved') {
  assert.equal(cut, 'setup', 'Crash cut was missed; outer result completed prematurely')
  assert(fault.factories > 0 && fault.stages > 0 && fault.installs > 0, 'native module factory/stage wrapper was not intercepted')
  assert.equal(fault.selectedInstalls, 1); assert.equal(fault.selectedObservations, 1); assert.equal(observed, 1)
  assert.equal(receipts, 1)
  await announce('setup')
  await service.close(); await coordinator.close()
  await send({ kind: 'closed' }); process.disconnect()
} else {
  const error = submission.error
  if (cut !== 'install') throw error
  const failures: unknown[] = [error], outcomes: unknown[] = [...fault.installOutcomes]
  while (failures.length) {
    const value = failures.pop()
    if (!value || typeof value !== 'object') continue
    const row = value as { outcome?: { code?: string }; cause?: unknown; errors?: unknown[] }
    if (row.outcome) outcomes.push(row.outcome)
    if (row.cause) failures.push(row.cause)
    if (row.errors) failures.push(...row.errors)
  }
  await writeFile(join(root, 'install-outcomes.json'), JSON.stringify(outcomes))
  const selectedOutcomes = fault.installOutcomes.filter(value => value.kind === 'recovery-required' && value.code === 'FACT_INSTALL_FAILED' && selected && JSON.stringify(value.receipt.key) === JSON.stringify(selected.batch.key))
  assert(selectedOutcomes.length > 0, 'Must observe original FACT_INSTALL_FAILED with selected original receipt/key')
  assert.equal(observed, 0); assert.equal(fault.selectedObservations, 0); assert(fault.selectedInstalls > 0)
  await announce('cut', { outcomes: selectedOutcomes, submitFailure: error instanceof Error ? { name: error.name, message: error.message, code: (error as { code?: string }).code } : String(error) }); await park()
}
