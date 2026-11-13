import { expect, it, vi } from 'vitest'
import type { FileHandle } from 'node:fs/promises'

const fault = vi.hoisted(() => ({
  path: '', fail: false, held: false, calls: 0,
  entered: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
  handle: undefined as FileHandle | undefined,
}))
vi.mock('node:fs/promises', async load => {
  const native = await load<typeof import('node:fs/promises')>()
  return { ...native, async open(...args: Parameters<typeof native.open>) {
    const handle = await native.open(...args)
    if (String(args[0]) !== fault.path || args[1] !== 'r+') return handle
    const close = handle.close.bind(handle)
    handle.close = async () => {
      fault.calls++
      if (fault.fail) { fault.fail = false; fault.handle = handle; throw Error('Original prewrite cleanup fault') }
      if (fault.held) { fault.entered?.(); await fault.gate }
      await close()
    }
    return handle
  } }
})

import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend } from '../src/index.ts'
import { createSessionCoordinator } from './helpers/composed.ts'
import * as managed from '../../session-persistence/src/coordinator/managed-document.ts'

it('refuses a Task-writer join while actual original native cleanup is held before append entry', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'journal-prewrite-cleanup-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { reportBackgroundFailure() {} })
  const factory = vi.spyOn(managed, 'createManagedDocument')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let action: ReturnType<ReturnType<typeof managed.createManagedDocument>['beginAction']> | undefined
  let source: ReturnType<NonNullable<typeof action>['registerSettlementSource']> | undefined
  let admission: Promise<import('@i-harness/core-session').ProducerFactOutcome> | undefined
  let primary: { cause: unknown } | undefined
  try {
    const { id } = await coordinator.create()
    const document = await coordinator.openManagedDocument(id)
    const ownership = factory.mock.calls.at(-1)![4]
    action = document.beginAction()
    source = action.registerSettlementSource(async () => {})
    const parent = managed.captureManagedRequiredParent(document, ownership, source)
    fault.path = join(root, id + '.jsonl')
    fault.fail = true
    expect(await action.captureMetadata!({ type: 'plan/mode', mode: 'on' }).admit()).toMatchObject({ kind: 'committed' })
    expect(fault.calls).toBe(1)
    expect(fault.handle!.fd).toBeGreaterThanOrEqual(0)
    fault.held = true
    fault.entered = entered.resolve
    fault.gate = release.promise
    admission = action.captureMetadata!({ type: 'plan/mode', mode: 'off' }).admit()
    void admission.catch(() => {})
    await Promise.race([entered.promise, admission.then(() => { throw Error('Original cleanup gate was not reached') })])
    // No await of the held callback is allowed here. The original native
    // append has not entered, so it supplies no prewrite scheduling proof.
    await expect(parent.acquireWriter()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(fault.handle!.fd).toBeGreaterThanOrEqual(0)
    fault.held = false
    release.resolve()
    expect(await admission).toMatchObject({ kind: 'committed' })
    expect(fault.handle!.fd).toBe(-1)
    const writer = await parent.acquireWriter()
    writer.release()
    await source.close()
    action.finish()
    action = undefined
    await coordinator.close()
  } catch (cause) {
    primary = { cause }
  } finally {
    fault.held = false
    fault.fail = false
    release.resolve()
    await admission?.catch(() => {})
    const failures: unknown[] = []
    for (const close of [() => source?.close(), async () => { action?.finish() }, () => coordinator.close()]) {
      try { await close() } catch (cause) { failures.push(cause) }
    }
    factory.mockRestore()
    fault.path = ''; fault.entered = undefined; fault.gate = undefined; fault.handle = undefined; fault.calls = 0
    if (primary && !failures.length) throw primary.cause
    if (failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original held native cleanup fixture failed', { cause: primary?.cause })
  }
})
