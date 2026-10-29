import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { rmWorkspaceSync } from './helpers.ts'
import { createContext } from '@i-harness/core-plugin'
import { createSession } from '@i-harness/core-session'
import { createToolRegistry, type AcceptedInstructionBatch } from '@i-harness/core-tools'
import { createFsTools } from '@i-harness/fs'

// The accepted preflight branch is explicitly controlled evidence, no transport.
it.each(['observe', 'preflight'] as const)('keeps a newer %s target stale across an older successful publication', async activation => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-i6-selection-')), environment = createProjectInstructionEnvironment(), session = createSession()
  const { mkdir } = await import('node:fs/promises')
  await writeFile(join(cwd, 'AGENTS.md'), 'ROOT'); await mkdir(join(cwd, 'nested')); await writeFile(join(cwd, 'nested', 'AGENTS.md'), 'NESTED')
  const target = join(cwd, 'nested', 'file'), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  await writeFile(target, 'existing readable target')
  let publications = 0, notices = 0, guards = 0, failSecondGuard = false, batch: AcceptedInstructionBatch | undefined
  const manager = createMainInstructionManager({ session, cwd, environment, available: () => true,
    authority() { if (failSecondGuard && ++guards === 2) throw new Error('original preflight authority unavailable'); return { kind: 'unbound', revision: '1', workspaceRoot: cwd } },
    async publish() { if (++publications === 2) { entered.resolve(); await release.promise } } })
  const unsubscribe = manager.diagnostics.subscribe(() => { notices++ })
  try {
    await manager.reconcile(); const evidence = manager.capture()!, original = manager.diagnostics.read().publication!
    if (activation === 'preflight') {
      const args = { path: target, text: 'never' }
      session.events.push({ type: 'tool/call', callId: 'write', name: 'write', args, seq: 0 })
      session.events.push({ type: 'model/exchange-accepted', version: 1, exchangeId: 'e', actionId: 'a', attemptId: 't', stepStartSeq: 0, assistantSeq: 0, callSeqs: [0], seq: 1 })
      batch = manager.succeeded({ evidence, candidate: { instructions: evidence } as never, acceptedSeq: 1, outcome: { kind: 'memory-committed', durability: 'nondurable', seqs: [1] }, physicalExecutionReceipt: { actionId: 'a', attemptId: 't' } as never, calls: [{ callId: 'write', eventSeq: 0, call: { name: 'write', args } }] })!
    }
    const publishing = manager.reconcile(); await entered.promise
    const beforeNotices = notices
    if (activation === 'observe') expect(await manager.observe({ path: target, kind: 'file' })).toEqual({ status: 'queued' })
    else {
      const tools = createToolRegistry(createContext()); for (const tool of createFsTools({ workspace: cwd })) tools.register(tool)
      const capture = tools.capture({ name: 'write', args: { path: target, text: 'never' } }, { session, callId: 'write', callEventSeq: 0 }), origin = batch!.bind(0, capture)
      failSecondGuard = true
      try { await expect(batch!.preflight([{ registry: tools, capture, origin }])).rejects.toMatchObject({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', data: { reason: 'revoked' } }) }
      finally { failSecondGuard = false }
    }
    await Promise.resolve()
    expect(notices).toBeGreaterThan(beforeNotices)
    release.resolve(); await publishing
    expect(manager.capture()).toBeUndefined()
    expect(manager.current(evidence)).toBe(true) // Do not change accepted-evidence eligibility to fix diagnostics.
    expect(manager.diagnostics.read()).toMatchObject({ state: 'stale', publication: original })
    expect(publications).toBe(2)
    await batch?.release(); batch = undefined
    const refreshed = await manager.diagnostics.refresh()
    expect(refreshed.state).toBe('ready'); expect(manager.capture()).toBeDefined()
    expect(refreshed.publication!.sources.some(source => source.path === join(cwd, 'nested', 'AGENTS.md'))).toBe(true)
    expect(publications).toBe(3)
  } finally { release.resolve(); unsubscribe(); await batch?.release(); await manager.close(); await environment.close(); rmWorkspaceSync(cwd) }
})

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

it('notifies when the original watched source changes without invoking publication', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-i6-source-event-')), path = join(cwd, 'AGENTS.md'); await writeFile(path, 'OLD_RULE')
  const environment = createProjectInstructionEnvironment(), manager = createMainInstructionManager({ cwd, environment, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: async () => { publications++ } })
  let publications = 0
  try {
    await manager.reconcile(); const event = Promise.withResolvers<void>()
    const unsubscribe = manager.diagnostics.subscribe(() => { if (manager.diagnostics.read().state !== 'ready') event.resolve() })
    await writeFile(path, 'NEW_RULE'); await event.promise
    expect(manager.diagnostics.read().state).not.toBe('ready'); expect(publications).toBe(1)
    unsubscribe()
  } finally { await manager.close(); await environment.close(); rmWorkspaceSync(cwd) }
})

it('reads cold instruction state without constructing an assembly or model', async () => {
  const { createSessionService } = await import('../src/index.ts')
  let calls = 0
  const model = { async *stream() { calls++; yield { type: 'end' as const } } }
  const cwd = await mkdtemp(join(tmpdir(), 'ih-i6-cold-'))
  const service = createSessionService({ workspace: cwd, model: model as never })
  try {
    expect(service.instructionState!('never-mounted')).toEqual({ state: 'not-published' })
    expect(await service.refreshInstructions!('never-mounted')).toEqual({ state: 'not-published' })
    expect(service.hasAssembly('never-mounted')).toBe(false); expect(calls).toBe(0)
  } finally { await service.close(); rmWorkspaceSync(cwd) }
}, 15000)

it('observes the actual live service publication and stops delivering after unsubscribe', async () => {
  const { createSessionService } = await import('../src/index.ts')
  const { createLoopbackProvider } = await import('../../core-agent/test/helpers/provider-loopback.ts')
  const { createOpenAICompatibleClient } = await import('../../llm-openai-compatible/src/index.ts')
  const cwd = await mkdtemp(join(tmpdir(), 'ih-i6-live-')); await writeFile(join(cwd, 'AGENTS.md'), 'SERVICE_LIVE_RULE')
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), service = createSessionService({ workspace: cwd, model })
  let notices = 0; const unsubscribe = service.onInstructionsChanged!('live', undefined, () => notices++)
  try {
    expect(service.instructionState!('live').state).toBe('not-published')
    await service.submit('live', 'hello', new AbortController().signal)
    expect(service.instructionState!('live')).toMatchObject({ state: 'ready', publication: { sources: [{ path: join(cwd, 'AGENTS.md'), state: 'loaded' }] } })
    expect(server.requests).toHaveLength(1); expect(JSON.stringify(server.requests[0]!.body)).toContain('SERVICE_LIVE_RULE')
    expect(notices).toBeGreaterThan(0); unsubscribe(); const prior = notices
    await service.refreshInstructions!('live'); await Promise.resolve(); expect(notices).toBe(prior); expect(server.requests).toHaveLength(1)
  } finally { unsubscribe(); await service.close(); await server.close(); rmWorkspaceSync(cwd) }
}, 15000)
