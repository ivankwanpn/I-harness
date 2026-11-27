import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, type ToolExec } from '@i-harness/core-tools'
import * as exec from '@i-harness/exec'
import type { AuthorityState } from '@i-harness/sandbox'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { guards, pair } from '../../session-persistence/test/child-bootstrap-fixture.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { captureTaskChildSearch } from '../src/owned-task-child-search.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-public-child-search-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    const { request, payload } = pair()
    const result = await coordinator.bootstrapChildTargetWithCapture!(request, guards, async () => payload)
    if (result.kind !== 'ready') throw Error('Original Task child did not reach ready')
    const document = result.document
    const ctx = createContext()
    const tools = createToolRegistry(ctx, { executionOwner: { view: document.view, factOwner: document, context: ctx, sessionId: 'target' } })
    const input = { ctx, tools, session: document.view, factOwner: document, sessionId: 'target', parentSessionId: 'parent',
      allowed: (name: string) => name === 'grep', retainCleanup() {} }
    return { root, coordinator, input, document, async close() { try { await coordinator.close() } finally { await rm(root, { recursive: true, force: true }) } } }
  } catch (cause) {
    try { await coordinator.close() } finally { await rm(root, { recursive: true, force: true }) }
    throw cause
  }
}

it('qualifies the already-held original child across title changes and appends', async () => {
  const { coordinator, input, document, close } = await fixture()
  try {
    const observed = captureTaskChildSearch(input, coordinator)
    expect(observed.policy()).toBeUndefined()
    expect(() => captureTaskChildSearch({ ...input, factOwner: { ...document } }, coordinator)).toThrow()
    expect(() => captureTaskChildSearch({ ...input, parentSessionId: 'different-parent' }, coordinator)).toThrow()
    expect(() => captureTaskChildSearch({ ...input, sessionId: 'different-child' }, coordinator)).toThrow()
    expect(() => captureTaskChildSearch(input, { ...coordinator })).toThrow()

    await expect(coordinator.updateMeta(input.sessionId, { title: 'Renamed child' })).resolves.toMatchObject({ title: 'Renamed child' })
    expect(() => observed.assertCurrent()).not.toThrow()
    await expect(document.metadata.admit({ type: 'sandbox/mode', mode: 'read-only' })).resolves.toMatchObject({ kind: 'committed' })
    const restricted = observed.policy()
    expect(restricted?.mode).toBe('read-only')
    await expect(document.metadata.admit({ type: 'sandbox/mode', mode: 'workspace-write' })).resolves.toMatchObject({ kind: 'committed' })
    const next = observed.policy()
    expect(next?.mode).toBe('workspace-write')
    expect(next?.seq).toBeGreaterThan(restricted!.seq!)
    document.revokeNewWork()
    expect(() => observed.assertCurrent()).toThrow()
  } finally { await close() }
})

it('declines an archived original child at a new mount', async () => {
  const { coordinator, input, close } = await fixture()
  try {
    await coordinator.closeManagedDocument(input.sessionId)
    await coordinator.updateMeta(input.sessionId, { archived: true })
    const document = await coordinator.openManagedDocument(input.sessionId)
    expect(document.view.header).toMatchObject({ archived: true })
    expect(() => captureTaskChildSearch({ ...input, session: document.view, factOwner: document }, coordinator)).toThrow('Original Task child document required')
  } finally { await close() }
})

it('uses the child native owner, exposes only allowed search leaves, and retries the original cleanup', async () => {
  const { root, coordinator, input, close } = await fixture()
  const real = exec.createExecService
  const called = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const firstFailure = Error('Original child Exec cleanup failed')
  let disposeOriginal: () => Promise<void>
  const stop = vi.fn(async () => {
    if (stop.mock.calls.length === 1) { called.resolve(); await release.promise; throw firstFailure }
    await disposeOriginal()
  })
  let host: exec.ExecExecutionHost | undefined
  const spy = vi.spyOn(exec, 'createExecService').mockImplementation(opts => {
    host = opts?.execution
    const service = real(opts)
    disposeOriginal = service.dispose.bind(service)
    return { ...service, dispose: stop }
  })
  let authority: AuthorityState = { kind: 'unbound', revision: 'test', workspaceRoot: root }
  const original = captureTaskChildSearch(input, coordinator)
  const search = original.create({ workspace: root, authority: () => authority, assertParentCurrent() {},
    standing: () => { const mode = original.policy()?.mode ?? 'workspace-write'; return { mode, generation: mode } }, execution: {} })
  try {
    search.mount()
    expect(input.tools.get('glob')).toBeUndefined()
    expect(input.tools.get('bash')).toBeUndefined()
    expect(() => input.ctx.services.get('exec/service')).toThrow('service not found')
    const grep = input.tools.get('grep')!
    await expect(grep.execute({ pattern: 'marker' }, {} as ToolExec)).rejects.toThrow('Original prepared search invocation required')
    const owner = host!.defaultOwner!
    expect(owner).toEqual({ sessionId: 'target', parentSessionId: 'parent' })
    expect(host!.resolvePolicy(owner, undefined).mode).toBe('workspace-write')
    authority = { kind: 'revoked', revision: 'revoked', reason: 'Project withdrawn' }
    expect(() => host!.resolvePolicy(owner, undefined)).toThrow('authority unavailable')

    const first = search.close(), observed = first.catch(cause => cause)
    await called.promise
    expect(search.close()).toBe(first)
    expect(() => search.mount()).toThrow('retired')
    release.resolve()
    expect(await observed).toBe(firstFailure)
    await search.close()
    await search.close()
    expect(stop).toHaveBeenCalledTimes(2)
  } finally { release.resolve(); await search.close().catch(() => {}); spy.mockRestore(); await close() }
})
