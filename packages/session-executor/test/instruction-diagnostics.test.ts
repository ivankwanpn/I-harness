import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { rmWorkspaceSync } from './helpers.ts'

it('exposes only the original successfully published source metadata and preserves it across failed refresh', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-i6-published-')); await writeFile(join(cwd, 'AGENTS.md'), 'PRIVATE_I6_SOURCE_TEXT')
  const environment = createProjectInstructionEnvironment(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let publishes = 0, fail = false, notifications = 0, authorityRevision = 'actual-authority'
  const manager = createMainInstructionManager({ cwd, environment, authority: () => ({ kind: 'unbound', revision: authorityRevision, workspaceRoot: cwd }), available: () => true,
    publish: async () => { publishes++; if (fail) throw new Error('original publication refused'); entered.resolve(); await release.promise } })
  const unsubscribe = manager.diagnostics.subscribe(() => notifications++)
  try {
    expect(manager.diagnostics.read()).toMatchObject({ state: 'not-published', effectivePolicy: { enabled: true } })
    const initial = manager.reconcile(); await entered.promise
    expect(manager.diagnostics.read()).toMatchObject({ state: 'pending', effectivePolicy: { enabled: true } })
    release.resolve(); await initial
    const report = manager.diagnostics.read()
    expect(report.state).toBe('ready'); expect(report.publication).toMatchObject({ authorityRevision: 'actual-authority', bytes: expect.any(Number), sources: [{ path: join(cwd, 'AGENTS.md'), state: 'loaded', bytes: expect.any(Number) }] })
    expect(JSON.stringify(report)).not.toContain('PRIVATE_I6_SOURCE_TEXT')
    fail = true; await expect(manager.diagnostics.refresh()).rejects.toThrow('original publication refused')
    const after = manager.diagnostics.read(); expect(after.state).toBe('stale'); expect(after.publication).toEqual(report.publication)
    expect(publishes).toBe(2); expect(notifications).toBeGreaterThan(0)
    authorityRevision = 'replacement-authority'; expect(manager.diagnostics.read()).toEqual({ state: 'revoked' })
    await manager.close(); expect(manager.diagnostics.read()).toEqual({ state: 'revoked' })
  } finally { release.resolve(); unsubscribe(); await manager.close().catch(() => {}); await environment.close(); rmWorkspaceSync(cwd) }
})

it('routes child diagnostics only through the original live session and fact owner', async () => {
  const { createSession, createNondurableFactOwner } = await import('@i-harness/core-session')
  const { createChildInstructionHost } = await import('../src/context/instructions/child-host.ts')
  const cwd = await mkdtemp(join(tmpdir(), 'ih-i6-child-')); await writeFile(join(cwd, 'AGENTS.md'), 'CHILD_DIAGNOSTIC_SOURCE')
  const environment = createProjectInstructionEnvironment(), parent = createSession(), parentOwner = createNondurableFactOwner(parent), child = createSession(), childOwner = createNondurableFactOwner(child), foreign = createNondurableFactOwner(createSession())
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, session: parent, publish: async () => {} })
  const host = createChildInstructionHost({ ...options, root: { session: parent, factOwner: parentOwner, manager } })
  const lease = host.create({ session: child, factOwner: childOwner, lifetime: { available: () => true } })
  try {
    expect(host.diagnosticsFor(child, foreign)).toBeUndefined()
    const diagnostics = host.diagnosticsFor(child, childOwner)!
    expect(diagnostics.read().state).toBe('not-published')
    await lease.requestContext.reconcile()
    expect(diagnostics.read()).toMatchObject({ state: 'ready', publication: { sources: [{ path: join(cwd, 'AGENTS.md'), state: 'loaded' }] } })
    expect(manager.diagnostics.read().state).toBe('not-published')
    let notices = 0; const unsubscribe = diagnostics.subscribe(() => notices++)
    lease.retire(); expect(diagnostics.read()).toEqual({ state: 'revoked' }); await Promise.resolve(); expect(notices).toBeGreaterThan(0)
    unsubscribe(); expect(host.diagnosticsFor(child, childOwner)).toBeUndefined()
  } finally { await lease.close(); await host.close(); await manager.close(); await environment.close(); rmWorkspaceSync(cwd) }
})

it('manual refresh republishes the live original source and never sends a model request', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-i6-refresh-')), path = join(cwd, 'AGENTS.md'); await writeFile(path, 'FIRST_RULE')
  const environment = createProjectInstructionEnvironment(), texts: string[] = []
  let manager!: ReturnType<typeof createMainInstructionManager>
  manager = createMainInstructionManager({ cwd, environment, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: async () => { texts.push(manager.text()) } })
  try {
    await manager.reconcile(); const before = manager.diagnostics.read().publication!
    await writeFile(path, 'SECOND_RULE')
    const after = await manager.diagnostics.refresh()
    expect(after.state).toBe('ready'); expect(after.publication!.fingerprint).not.toBe(before.fingerprint)
    expect(texts).toHaveLength(2); expect(texts[1]).toContain('SECOND_RULE')
  } finally { await manager.close(); await environment.close(); rmWorkspaceSync(cwd) }
})
