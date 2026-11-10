import { expect, it, vi } from 'vitest'
const reads = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile(...args: Parameters<typeof fs.readFile>) { reads.push(String(args[0])); return fs.readFile(...args) } }
})
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createFsTools } from '@i-harness/fs'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'

it.each((['allowed-once', 'rejected'] as const).flatMap(decision => (['external', 'canonical-escape'] as const).map(route => ({ decision, route }))))('keeps $route instruction discovery scoped while original escalation is $decision', async ({ decision, route }) => {
  const root = await mkdtemp(join(tmpdir(), 'ih-external-instruction-mutation-'))
  const cwd = join(root, 'project'), outside = join(root, 'outside')
  await mkdir(cwd); await mkdir(outside)
  await writeFile(join(cwd, 'AGENTS.md'), 'PROJECT_RULE')
  const alias = join(cwd, 'alias')
  if (route === 'canonical-escape') await symlink(outside, alias, 'junction')
  const outsideRules = join(outside, 'AGENTS.md'), target = join(route === 'external' ? outside : alias, 'result.txt')
  await writeFile(outsideRules, 'OUTSIDE_RULE_MUST_NOT_BE_READ')
  reads.length = 0
  const environment = createProjectInstructionEnvironment(), session = createSession()
  const manager = createMainInstructionManager({ session, environment, cwd, authority: () => ({ kind: 'unbound', revision: 'one', workspaceRoot: cwd }), available: () => true, publish: async () => {} })
  const approve = vi.fn(async () => decision), guardedModes: unknown[] = []
  let release = async () => {}
  try {
    await manager.reconcile()
    const evidence = manager.capture()!, args = { path: target, text: 'authorized bytes', sandbox_permissions: 'danger-full-access', justification: 'Write the explicitly selected external test file.' }
    session.events.push({ type: 'tool/call', callId: 'external', name: 'write', args, seq: 0 })
    session.events.push({ type: 'model/exchange-accepted', version: 1, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt', stepStartSeq: 0, assistantSeq: 0, callSeqs: [0], seq: 1 })
    const batch = manager.succeeded({ evidence, candidate: { instructions: evidence } as never, acceptedSeq: 1, outcome: { kind: 'memory-committed', durability: 'nondurable', seqs: [1] }, physicalExecutionReceipt: { actionId: 'action', attemptId: 'attempt' } as never, calls: [{ callId: 'external', eventSeq: 0, call: { name: 'write', args } }] })!
    release = batch.release
    const tools = createToolRegistry(createContext())
    for (const tool of createFsTools({ workspace: cwd, sandboxPolicy: () => ({ mode: 'workspace-write', workspaceRoot: cwd }), escalationApprover: { request: approve }, writeGuard(path, mode) { expect(path).toBe(target); guardedModes.push(mode); if (mode !== 'danger-full-access') throw Error('External write still requires original escalation'); return {ok:true} } })) tools.register(tool)
    const capture = tools.capture({ name: 'write', args }, { session, callId: 'external', callEventSeq: 0 }), origin = batch.bind(0, capture)
    await batch.preflight([{ registry: tools, capture, origin }])
    await tools.dispatch(await tools.prepareCaptured(capture, undefined, origin))
    expect(approve).toHaveBeenCalledOnce()
    expect(reads).not.toContain(outsideRules)
    expect(reads).not.toContain(join(alias, 'AGENTS.md'))
    expect(manager.text()).toContain('PROJECT_RULE')
    expect(manager.text()).not.toContain('OUTSIDE_RULE_MUST_NOT_BE_READ')
    if (decision === 'allowed-once') { expect(guardedModes.length).toBeGreaterThan(0); expect(await readFile(target, 'utf8')).toBe('authorized bytes') }
    else { expect(guardedModes).toEqual([]); await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' }) }
  } finally { await release(); await manager.close(); await environment.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)
