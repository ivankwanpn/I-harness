import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, createNondurableFactOwner, type SessionView } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, type ToolExec } from '@i-harness/core-tools'
import { createFsTools } from '@i-harness/fs'
import { createAgent } from '@i-harness/core-agent'
import { createMockClient } from '@i-harness/llm-mock'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createChildInstructionHost } from '../src/context/instructions/child-host.ts'
import { rmWorkspaceSync } from './helpers.ts'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'ic-r-')), environment = createProjectInstructionEnvironment()
  await writeFile(join(cwd, 'AGENTS.md'), 'ROUTER_ROOT_RULE')
  const dirs = [join(cwd, 'a'), join(cwd, 'b'), join(cwd, 'c')]
  for (let i = 0; i < dirs.length; i++) { await mkdir(dirs[i]!); await writeFile(join(dirs[i]!, 'AGENTS.md'), `CHILD_${i}_RULE`); await writeFile(join(dirs[i]!, 'data'), 'é real bytes') }
  const root = createSession(), factOwner = createNondurableFactOwner(root)
  const options = { cwd, environment, available: () => true, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }) }
  const manager = createMainInstructionManager({ ...options, publish: async () => {} })
  const host = createChildInstructionHost({ ...options, root: { session: root, factOwner, manager } })
  const sessions = [createSession(), createSession()], owners = sessions.map(createNondurableFactOwner)
  const leases = sessions.map((session, i) => host.create({ session, factOwner: owners[i]!, lifetime: { available: () => true } }))
  const ctx = createContext(), tools = createFsTools({ workspace: cwd, readPolicy: { maxOutputBytes: 4096 }, observeInstructionTarget: host.observe })
  const registries = sessions.map(() => { const registry = createToolRegistry(ctx); for (const tool of tools) registry.register(tool); return registry })
  const run = async (index: number, name: string, args: unknown) => {
    const registry = registries[index]!, session = sessions[index]!
    const prepared = await registry.prepare({ name, args }, undefined, { session, callId: `${name}-${index}` })
    expect(prepared.exec.session).toBe(session)
    return registry.dispatch(prepared)
  }
  const text = (index: number) => JSON.stringify(sessions[index]!.events.findLast(event => event.type === 'runtime/context'))
  return { ...options, root, manager, host, sessions, owners, leases, ctx, registries, dirs, run, text, async close() {
    await host.close(); await manager.close(); await environment.close(); rmWorkspaceSync(cwd)
  } }
}

it('routes inherited real read/list objects by exact prepared view with disjoint target/evidence/publication state', async () => {
  const f = await fixture()
  try {
    expect(f.registries[0]!.get('read')).toBe(f.registries[1]!.get('read'))
    await f.manager.reconcile(); const rootEvidence = f.manager.capture(), parentText = f.manager.text(), rootEvents = [...f.root.events]
    expect(await f.run(0, 'read', { path: join(f.dirs[0]!, 'data') })).toMatchObject({ content: 'é real bytes', instruction_scope: { status: 'queued' } })
    expect(await f.run(1, 'list_dir', { path: f.dirs[1] })).toMatchObject({ instruction_scope: { status: 'queued' } })
    await Promise.all(f.leases.map(lease => lease.requestContext.reconcile()))
    expect(f.text(0)).toContain('CHILD_0_RULE'); expect(f.text(0)).not.toContain('CHILD_1_RULE')
    expect(f.text(1)).toContain('CHILD_1_RULE'); expect(f.text(1)).not.toContain('CHILD_0_RULE')
    const [a, b] = f.leases.map(lease => lease.requestContext.capture())
    expect(a).toBeDefined(); expect(b).toBeDefined(); expect(a).not.toBe(b)
    expect(f.leases[0]!.requestContext.current(b)).toBe(false)
    expect(f.manager.capture()).toBe(rootEvidence); expect(f.manager.text()).toBe(parentText); expect(f.root.events).toEqual(rootEvents)
  } finally { await f.close() }
})

it('invalid pages and failed filesystem reads never activate; metadata IDs and cloned/foreign views never select a manager', async () => {
  const f = await fixture(), path = join(f.dirs[0]!, 'data')
  try {
    expect(await f.run(0, 'read', { path, digest: 'bad' })).toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await f.run(0, 'read', { path, offset_bytes: 1 })).toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    expect(await f.run(0, 'read', { path: join(f.dirs[0]!, 'missing') })).toMatchObject({ code: 'ENOENT' })
    expect(await f.run(0, 'list_dir', { path: join(f.dirs[0]!, 'missing') })).toMatchObject({ code: 'ENOENT' })
    for (const exec of [{ sessionId: 'same', instructionText: 'CHILD_0_RULE' }, { session: { ...f.sessions[0]! } }, { session: createSession() }]) {
      expect(await f.host.observe({ path, kind: 'file' }, exec as ToolExec)).toEqual({ status: 'reference-only', reason: 'outside-root' })
    }
    await f.leases[0]!.requestContext.reconcile()
    expect(f.text(0)).not.toContain('CHILD_0_RULE')
    f.leases[0]!.retire()
    expect(await f.host.observe({ path, kind: 'file' }, { session: f.sessions[0] })).toEqual({ status: 'unavailable', reason: 'mapping-unavailable' })
  } finally { await f.close() }
})

it('asynchronous target mapping completion order preserves canonical text and render does not acknowledge pending targets', async () => {
  const f = await fixture(), original = fs.realpath, slow = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const target = join(f.dirs[1]!, 'data')
  const mapping = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => { if (String(args[0]) === target) { entered.resolve(); await slow.promise }; return original(...args) })
  try {
    const pending = f.host.observe({ path: target, kind: 'file' }, { session: f.sessions[0] }); await entered.promise
    await f.host.observe({ path: f.dirs[0]!, kind: 'directory' }, { session: f.sessions[0] }); slow.resolve(); await pending
    await f.host.observe({ path: f.dirs[0]!, kind: 'directory' }, { session: f.sessions[1] })
    await f.host.observe({ path: target, kind: 'file' }, { session: f.sessions[1] })
    await Promise.all(f.leases.map(lease => lease.requestContext.reconcile()))
    const sections = (session: SessionView) => session.events.findLast(event => event.type === 'runtime/context')
    expect(sections(f.sessions[0]!)).toEqual(sections(f.sessions[1]!))
    const a = f.leases[0]!
    await f.host.observe({ path: f.dirs[2]!, kind: 'directory' }, { session: f.sessions[0] })
    await a.requestContext.reconcile()
    expect(f.text(0)).toContain('CHILD_0_RULE'); expect(f.text(0)).toContain('CHILD_1_RULE'); expect(f.text(0)).toContain('CHILD_2_RULE')
    // A local completion is real Agent execution, but deliberately has no
    // physical receipt and cannot consume this child's pending wave.
    const agent = createAgent(f.ctx, { session: f.sessions[0]!, factOwner: f.owners[0], tools: f.registries[0]!, requestContext: a.requestContext,
      model: createMockClient([{ role: 'assistant', text: 'accepted child answer' }]), systemPrompt: 'router library request', budget: { contextWindow: 100000 } })
    await agent.followup('continue the real owned child context')
    await f.host.observe({ path: f.dirs[0]!, kind: 'directory' }, { session: f.sessions[0] })
    // Same consumed target is stable; a new wave takes effect on another target.
    await a.requestContext.reconcile()
    expect(f.text(0)).toContain('CHILD_2_RULE')
    a.requestContext.promotedHumanRequest()
    await a.requestContext.reconcile()
    expect(f.text(0)).not.toContain('CHILD_0_RULE')
    expect(f.text(1)).toContain('CHILD_0_RULE'); expect(f.manager.text()).toBe('')
  } finally { slow.resolve(); mapping.mockRestore(); await f.close() }
})

it('canonical escape content remains reference-only in the real filesystem tool', async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'ic-o-'))
  try {
    await writeFile(join(outside, 'AGENTS.md'), 'EXTERNAL_POISON'); await writeFile(join(outside, 'data'), 'external bytes')
    await symlink(outside, join(f.cwd, 'alias'), 'junction')
    expect(await f.run(0, 'read', { path: join(f.cwd, 'alias', 'data') })).toMatchObject({ content: 'external bytes', instruction_scope: { status: 'reference-only', reason: 'canonical-escape' } })
    await f.leases[0]!.requestContext.reconcile(); expect(f.text(0)).not.toContain('EXTERNAL_POISON')
  } finally { await f.close(); rmWorkspaceSync(outside) }
})

it('captures its original borrowed root references once even if the constructor options are later changed', async () => {
  const f = await fixture(), root = { session: f.root, factOwner: createNondurableFactOwner(f.root), manager: f.manager }
  const options = { cwd: f.cwd, environment: f.environment, authority: f.authority, available: f.available, root }
  const host = createChildInstructionHost(options)
  try {
    const foreign = createSession(); root.session = foreign; root.factOwner = createNondurableFactOwner(foreign)
    expect(await host.observe({ path: f.dirs[0]!, kind: 'directory' }, { session: f.root })).toEqual({ status: 'queued' })
    expect(await host.observe({ path: f.dirs[1]!, kind: 'directory' }, { session: foreign })).toEqual({ status: 'reference-only', reason: 'outside-root' })
    await f.manager.reconcile(); expect(f.manager.text()).toContain('CHILD_0_RULE'); expect(f.manager.text()).not.toContain('CHILD_1_RULE')
  } finally { await host.close(); await f.close() }
})
