import assert from 'node:assert/strict'
import { it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import type { TaskProtocolDocument } from '@i-harness/subagent'
import { launch } from './helpers/publication-launch.mts'
import { cuts, type Transition } from './helpers/publication-native.mts'
import { assertPins, expectedBody, inventory, originalOperation, parent, readAll, type Inventory } from './helpers/publication-fixture.mts'

// Artifact commitment/readability must never upgrade the earlier running task
// document or recreate the dead original capture/source/second-pin authority.
it.each(cuts)('hard-kills the original owner after native %s and classifies through fresh read ownership', async cut => {
  const fixture = await launch('crash', cut)
  let closeReader: (() => Promise<void>) | undefined
  try {
    const receipt = await fixture.message('cut')
    const transitions = receipt.transitions as Transition[], files = receipt.files as Inventory
    const operation = originalOperation(files).operation
    const baseline = receipt.baseline as TaskProtocolDocument, baselineBytes = Buffer.from(receipt.baselineBase64 as string, 'base64')
    assert.deepEqual(transitions.map(row => row.cut), cuts.slice(0, cuts.indexOf(cut) + 1))
    assert.equal(operation.owner.operationId, receipt.operationId)
    const expectedPhase = cuts.indexOf(cut) < 3 ? 'capturing' : cuts.indexOf(cut) < 7 ? 'staged' : 'committed'
    assert.equal(operation.phase, expectedPhase)
    assertPins(files, receipt.taskDocument as string, cuts.indexOf(cut))
    assert.deepEqual(receipt.authority, { registrations: 1, begins: 1, sameScope: true, sameSink: true, codec: 'json-utf8-v1' })
    const count = receipt.count as { captures: number; resultTextReads: number; errorReads: number; sourceBindings: number }
    assert.equal(count.captures, 1); assert.equal(count.resultTextReads, 1); assert.equal(count.errorReads, 1); assert.equal(count.sourceBindings, 1)
    const disposition = await fixture.kill(); assert(disposition.code !== 0 || disposition.signal !== null)
    const { createSessionCoordinator } = await import('@i-harness/session-persistence')
    const { createJsonlBackend } = await import('@i-harness/session-persistence-jsonl')
    const { acquireResultReadStore } = await import('../src/lifecycle/result-store.ts')
    const { createTaskRegistry, SHIPPING_REPORT_POLICY } = await import('@i-harness/subagent')
    const { createTaskResultRetention } = await import('../src/lifecycle/task-result-retention.ts')
    const { contextWorkspaceLocation } = await import('@i-harness/context-output')
    const store = join(fixture.root, 'sessions'), coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
    let freshReadOpen = true
    const lease = await acquireResultReadStore({ workspace: fixture.root, coordinator, sessionId: parent, contextOutputSettingsPath: join(fixture.config, 'settings.json'), readCallerAvailable: () => freshReadOpen })
    closeReader = async () => { freshReadOpen = false; await lease.release(); await coordinator.close() }
    assert(lease.service && lease.sourceFor)
    assert.equal(coordinator.ownerOf(parent), false)
    const location = await contextWorkspaceLocation(fixture.root, store)
    assert.deepEqual(await inventory(location.serviceRoot), files)
    assert.deepEqual(await readFile(receipt.documentPath as string), baselineBytes)
    assert.deepEqual(await coordinator.getDocument(receipt.taskDocument as string), baseline)
    const classification = await lease.service.reconcileResult(operation.owner.operationId, operation.id)
    let body: unknown
    if (expectedPhase === 'committed') {
      assert.equal(classification.kind, 'committed')
      assert(classification.kind === 'committed' && operation.ref)
      assert.deepEqual(classification.ref, operation.ref)
      body = await readAll(lease.service, classification.ref, expectedBody())
    } else {
      assert.equal(classification.kind, 'recovery-required')
      if (operation.ref) await assert.rejects(lease.service.readResult({ sessionId: parent }, { ref: operation.ref as ManagedArtifactRef, maxBytes: 1024 }))
    }
    const tasks = createTaskRegistry({ coordinator, stateId: parent, reportPolicy: SHIPPING_REPORT_POLICY, results: createTaskResultRetention(lease.service, lease.sourceFor, parent) })
    tasks.restore(structuredClone(baseline)); await tasks.qualifyRestoredResults()
    assert.deepEqual(tasks.list(), baseline.tasks); assert.deepEqual(tasks.notifications(), baseline.notifications)
    assert.equal(tasks.get(baseline.tasks[0]!.id)!.status, 'running')
    assert.equal(tasks.get(baseline.tasks[0]!.id)!.outcome, undefined)
    assert.equal(tasks.get(baseline.tasks[0]!.id)!.result, undefined)
    assert.deepEqual((await coordinator.snapshot!(parent)).session.events, [])
    assert.equal(coordinator.ownerOf(parent), false)
    assert.deepEqual(await inventory(location.serviceRoot), files)
    assert.deepEqual(await readFile(receipt.documentPath as string), baselineBytes)
    await writeFile(join(fixture.root, 'fresh.json'), JSON.stringify({ disposition, expectedPhase, classification, body, restored: { tasks: tasks.list(), notifications: tasks.notifications() }, inventory: files, producerOwnership: false }, null, 2))
  } finally { try { await closeReader?.() } finally { await fixture.cleanup() } }
}, 30000)
