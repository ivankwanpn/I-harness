import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cuts, hash, installPublicationProbe, type Cut, type Transition } from './publication-native.mts'
import { createFixture, inventory, originalOperation, parent, readAll, bodyLength, assertPins } from './publication-fixture.mts'

const [root, mode, selectedArg, nonce] = process.argv.slice(2)
assert(root && mode && selectedArg && nonce && process.env.IH_CONFIG_DIR)
const selected = selectedArg as Cut
process.on('message', () => {}) // Owned IPC keeps a physically parked promise alive.
const send = (kind: string, value: object = {}) => new Promise<void>((accept, reject) => process.send!({ nonce, parent, mode, selected, kind, ...value }, error => error ? reject(error) : accept()))
const park = () => new Promise<never>(() => {})
const quotaCalls: { growth: number; quota: number; physical: number; error?: { code?: string; message: string }; inventory: Awaited<ReturnType<typeof inventory>> }[] = []
// Transparent original quota observer: delegate unchanged; record actual errors.
const quota = await import('../../../context-output/src/artifact/quota.ts')
mock.module(import.meta.resolve('../../../context-output/src/artifact/quota.ts'), { cache: true, namedExports: { ...quota,
  async requireSpace(...args: Parameters<typeof quota.requireSpace>) {
    const files = await inventory(args[0]), physical = Object.values(files).reduce((total, row) => total + row.bytes, 0)
    const row: typeof quotaCalls[number] = { growth: args[2], quota: args[1], physical, inventory: files }; quotaCalls.push(row)
    try { return await quota.requireSpace(...args) }
    catch (error) { row.error = { code: (error as { code?: string }).code, message: (error as Error).message }; throw error }
  },
} })
let fixture: Awaited<ReturnType<typeof createFixture>> | undefined, hit = false
let cutEvidence: object | undefined
const probe = await installPublicationProbe(parent, 'task-' + parent, async (transition: Transition) => {
  if (mode === 'control' || mode.startsWith('quota') || hit || transition.cut !== selected) return
  hit = true; assert(fixture)
  await fixture.assertBaseline()
  const files = await inventory(fixture.location.serviceRoot)
  const operation = originalOperation(files).operation
  assertPins(files, fixture.taskDocument, cuts.indexOf(selected))
  const originalBody = Object.entries(files).find(([path]) => path.endsWith('/body'))
  assert(originalBody); assert.equal(originalBody[1].bytes, fixture.expected.length); assert.equal(originalBody[1].sha256, hash(fixture.expected))
  assert.equal(operation.owner.operationId, fixture.operationId)
  assert.equal(operation.owner.documentId, fixture.taskDocument)
  assert.equal(operation.owner.callId, fixture.task.id)
  assert.equal(operation.owner.sessionId, parent)
  assert(operation.owner.source.sourceId.startsWith('session-scope:'))
  assert.deepEqual(probe.transitions.map(row => row.cut), cuts.slice(0, cuts.indexOf(selected) + 1))
  assert.equal(fixture.task.result?.kind, 'pending')
  cutEvidence = { transition, transitions: [...probe.transitions], files, operation, task: structuredClone(fixture.task), count: { ...fixture.count }, operationId: fixture.operationId,
    authority: { ...fixture.authority }, baseline: fixture.baseline, baselineBase64: fixture.baselineBytes.toString('base64'), documentPath: fixture.documentPath, taskDocument: fixture.taskDocument, quotaCalls }
  await writeFile(join(root, 'cut.json'), JSON.stringify(cutEvidence, null, 2))
  if (mode === 'crash') { await send('cut', cutEvidence); await park() }
  throw new Error('controlled lost acknowledgement after successful native ' + selected)
})
try {
  const length = mode === 'quota-second' ? 1_850_000 : mode === 'quota-commit' ? 1_700_000 : bodyLength
  //1,700,053JSON bytes: last write inventory+reserve=1,832,386;
  // commit inventory+index/reserve=1,899,970. Fixed1,870,000 separates them.
  const budget = mode === 'quota-commit' ? 1_870_000 : mode === 'quota-second' ? 2_097_152 : undefined
  fixture = await createFixture(root, length, budget)
  fixture.terminalize()
  const attempt = await fixture.tasks.retainResult(fixture.task.id).then(() => ({ kind: 'resolved' as const }), error => ({ kind: 'rejected' as const, code: (error as { code?: string }).code, message: (error as Error).message }))
  await fixture.terminalized // Joins the actual automatic attempt, success OR failure.
  await fixture.tasks.flushPersistence()
  if (mode === 'crash') throw new Error('SETUP: selected native cut did not park')
  if (mode === 'control') {
    assert.equal(attempt.kind, 'resolved'); assert.deepEqual(probe.transitions.map(row => row.cut), cuts)
  } else if (mode.startsWith('quota')) {
    // An explicit join can observe the automatic attempt's already persisted
    // failed quota retention and reject. The existing descriptor is authoritative.
    if (attempt.kind === 'rejected') assert.equal(attempt.message, 'quota')
    assert(fixture.task.result?.kind === 'retained' && fixture.task.result.envelope.retention.kind === 'unavailable')
    assert.equal(fixture.task.result.envelope.retention.reason, 'quota')
    assert.equal(fixture.task.result.envelope.retention.observedEncodedBytes, fixture.expected.length)
    assert.equal(fixture.task.retention, 'failed'); assert.equal(fixture.task.outcome, 'completed')
    assert.equal(fixture.count.terminalCallbacks, 1)
    assert.deepEqual(fixture.task.result.envelope.execution, { outcome: 'succeeded', dispatch: 'dispatched' })
    const refusal = quotaCalls.filter(row => row.error)
    assert.equal(refusal.length, 1); assert.equal(refusal[0]!.error!.code, 'ARTIFACT_QUOTA')
    assert(refusal[0]!.physical + refusal[0]!.growth > budget!)
    assert(quotaCalls.slice(0, quotaCalls.indexOf(refusal[0]!)).every(row => row.physical + row.growth <= budget!))
    const files = await inventory(fixture.location.serviceRoot), operation = originalOperation(files).operation
    assert.equal(operation.owner.operationId, fixture.operationId)
    let body: unknown
    if (mode === 'quota-commit') {
      assert.equal(originalOperation(refusal[0]!.inventory).operation.phase, 'capturing')
      const leaves = Math.max(1, Math.ceil(fixture.expected.length / 65536)), padded = 2 ** Math.ceil(Math.log2(leaves))
      assert.equal(refusal[0]!.growth, 64 + 32 * (2 * padded - 1) + 196608)
      assert.equal(operation.phase, 'refused'); assert.equal(operation.reason, 'quota'); assert.equal(operation.encodedBytes, fixture.expected.length)
      assert.equal(probe.transitions.length, 0)
      assert(Object.values(refusal[0]!.inventory).some(row => row.bytes === fixture!.expected.length && row.sha256 === hash(fixture!.expected)))
    } else {
      assert.equal(originalOperation(refusal[0]!.inventory).operation.phase, 'committed')
      assert.equal(refusal[0]!.growth, 262144); assert.equal(operation.phase, 'committed'); assert(operation.ref)
      assert.deepEqual(probe.transitions.map(row => row.cut), cuts.slice(0, 8))
      assert.equal(Object.keys(files).filter(path => path.includes('/pins/')).length, 1)
      const access = Object.entries(files).find(([path]) => path.includes('/access/'))
      assert(access); assert.equal(JSON.parse(access[1].text!).pinId, (await import('./publication-native.mts')).hash(fixture.taskDocument))
      body = await readAll(fixture.lease.service!, operation.ref, fixture.expected)
    }
    const descriptor = structuredClone(fixture.task.result)
    await fixture.tasks.retainResult(fixture.task.id)
    assert.deepEqual(fixture.task.result, descriptor)
    assert.deepEqual(await inventory(fixture.location.serviceRoot), files)
    await send('done', { attempt, files, operation, count: fixture.count, task: fixture.task, quotaCalls, body })
  } else {
    assert(hit, 'SETUP: native interception missed')
    assert.deepEqual(attempt.kind, 'rejected'); assert('code' in attempt && attempt.code === 'FACT_RECOVERY_REQUIRED')
    await fixture.assertBaseline()
    assert.equal(fixture.task.outcome, 'completed'); assert.equal(fixture.task.result?.kind, 'pending')
    assert(fixture.capture && fixture.captures[0] === fixture.capture)
    if (mode === 'closure') fixture.closeComponent()
    if (mode === 'delete') await fixture.coordinator.deleteOwnedSession!(parent, { documents: [fixture.taskDocument] })
    const retry = await fixture.tasks.retainResult(fixture.task.id).then(() => ({ kind: 'resolved' as const }), error => ({ kind: 'rejected' as const, code: (error as { code?: string }).code, message: (error as Error).message }))
    await fixture.tasks.flushPersistence()
    if (mode === 'live') assert.equal(retry.kind, 'resolved')
    else {
      const afterRetry = fixture.tasks.get(fixture.task.id)!.result
      assert(!(afterRetry?.kind === 'retained' && afterRetry.envelope.retention.kind === 'artifact'))
      const files = await inventory(fixture.location.serviceRoot)
      if (mode === 'delete') {
        assert.equal(Object.keys(files).filter(path => path.includes('/pins/') || path.includes('/access/')).length, 0)
        assert(await fixture.coordinator.deletionReceipt!(parent))
        await assert.rejects(fixture.lease.sourceFor!(parent))
        const candidate = (cutEvidence as { operation: { ref?: import('@i-harness/core-session').ManagedArtifactRef } }).operation.ref
        const oldService = fixture.lease.service
        // This is post-measurement cleanup, then a genuinely distinct read store.
        await fixture.close()
        const { createSessionCoordinator } = await import('@i-harness/session-persistence')
        const { createJsonlBackend } = await import('@i-harness/session-persistence-jsonl')
        const { acquireResultReadStore } = await import('../../src/lifecycle/result-store.ts')
        const fresh = createSessionCoordinator(createJsonlBackend(fixture.store), { lock: { enabled: true } })
        let freshReadOpen = true
        const lease = await acquireResultReadStore({ workspace: root, coordinator: fresh, sessionId: parent, contextOutputSettingsPath: fixture.settings, readCallerAvailable: () => freshReadOpen })
        try {
          assert(lease.service && lease.sourceFor); assert.notEqual(lease.service, oldService)
          const receipt = await fresh.deletionReceipt!(parent); assert(receipt)
          const refusal = async (work: Promise<unknown>) => {
            const result = await work.then(() => ({ kind: 'unexpected-success' as const }), error => ({ kind: 'rejected' as const, code: (error as NodeJS.ErrnoException).code, message: (error as Error).message }))
            assert.equal(result.kind, 'rejected'); return result
          }
          const profileDisposition = await refusal(fresh.profile(parent)), sourceDisposition = await refusal(lease.sourceFor(parent))
          let readDisposition: unknown = 'no-candidate-ref'
          if (candidate) readDisposition = await lease.service.readResult({ sessionId: parent }, { ref: candidate, maxBytes: 1024 }).then(() => 'unexpected-readable', error => ({ code: (error as NodeJS.ErrnoException).code, message: (error as Error).message }))
          assert.notEqual(readDisposition, 'unexpected-readable')
          assert.deepEqual(await inventory(fixture.location.serviceRoot), files)
          assert.equal(fresh.ownerOf(parent), false)
          await send('done', { attempt, retry, cutEvidence, files, task: fixture.task, count: fixture.count, fresh: { distinctService: true, receipt, profileDisposition, sourceDisposition, readDisposition, producerOwnership: false } })
        } finally { freshReadOpen = false; await lease.release(); await fresh.close() }
      } else await send('done', { attempt, retry, cutEvidence, files, task: fixture.task, count: fixture.count, componentOpen: false })
    }
  }
  assert.equal(fixture.count.captures, 1); assert.equal(fixture.count.sourceBindings, 1)
  assert.deepEqual(fixture.authority, { registrations: 1, begins: 1, sameScope: true, sameSink: true, codec: 'json-utf8-v1' })
  assert.equal(fixture.count.resultTextReads, 1); assert.equal(fixture.count.errorReads, 1)
  assert.equal(fixture.task.outcome, 'completed')
  assert.equal(fixture.task.publication, undefined)
  if (mode === 'control' || mode === 'live') {
    assert(fixture.task.result?.kind === 'retained' && fixture.task.result.envelope.retention.kind === 'artifact')
    const ref = fixture.task.result.envelope.retention.ref, files = await inventory(fixture.location.serviceRoot), operation = originalOperation(files).operation
    assert.equal(operation.owner.operationId, fixture.operationId); assert.equal(fixture.task.result.revision, fixture.operationId)
    assert.equal(operation.phase, 'committed'); assert.deepEqual(operation.ref, ref)
    assert.equal(Object.keys(files).filter(path => path.includes('/pins/')).length, 2)
    assert.equal(Object.keys(files).filter(path => path.endsWith('.pending')).length, 0)
    const pins = Object.entries(files).filter(([path]) => path.includes('/pins/')).map(([, row]) => JSON.parse(row.text!))
    assert.deepEqual(pins.map(pin => pin.documentId).sort(), [parent, fixture.taskDocument].sort())
    for (const pin of pins) { assert.equal(pin.state, 'pending'); assert.equal(pin.operationId, fixture.operationId); assert.equal(pin.revision, ref.revision) }
    const access = Object.entries(files).find(([path]) => path.includes('/access/')); assert(access)
    assert.equal(JSON.parse(access[1].text!).pinId, (await import('./publication-native.mts')).hash(parent))
    if (cutEvidence) {
      const candidate = (cutEvidence as { operation: { ref?: typeof ref } }).operation.ref
      if (candidate) assert.deepEqual(ref, candidate)
    }
    const body = await readAll(fixture.lease.service!, ref, fixture.expected)
    assert.equal(fixture.task.retention, 'durable')
    assert.deepEqual(fixture.task.result.envelope.execution, { outcome: 'succeeded', dispatch: 'dispatched' })
    assert.equal(fixture.count.terminalCallbacks, 1)
    await send('done', { attempt, cutEvidence, files, operation, ref, task: fixture.task, count: fixture.count, authority: fixture.authority, transitions: probe.transitions, body, quotaCalls })
  }
  await fixture.close(); probe.restore(); mock.restoreAll()
  await send('closed'); process.disconnect()
} catch (error) {
  await writeFile(join(root, 'failure.json'), JSON.stringify({ message: (error as Error).message, stack: (error as Error).stack, hit, transitions: probe.transitions, quotaCalls, cutEvidence, task: fixture?.task, count: fixture?.count }, null, 2))
  probe.restore(); throw error
}
