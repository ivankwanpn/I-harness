import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createSession } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createFsTools } from '@i-harness/fs'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createMainInstructionManager, isOriginalAcceptedInstructionOrigin } from '../src/context/instructions/manager.ts'
import { rmWorkspaceSync } from './helpers.ts'

// Controlled accepted-evidence fixture: no physical transport is claimed.
it('retains the originating view until the accepted call batch releases', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-accepted-batch-')), environment = createProjectInstructionEnvironment(), session = createSession()
  const manager = createMainInstructionManager({ session, environment, cwd, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: async () => {} })
  try {
    await manager.reconcile(); const evidence = manager.capture()!
    session.events.push({ type: 'tool/call', callId: 'c', name: 'read', args: { path: 'a' }, seq: 0 })
    session.events.push({ type: 'model/exchange-accepted', version: 1, exchangeId: 'e', actionId: 'a', attemptId: 't', stepStartSeq: 0, assistantSeq: 0, callSeqs: [0], seq: 1 })
    const batch = manager.succeeded({ evidence, candidate: { instructions: evidence } as never, acceptedSeq: 1,
      outcome: { kind: 'memory-committed', durability: 'nondurable', seqs: [1] }, physicalExecutionReceipt: { actionId: 'a', attemptId: 't' } as never,
      calls: [{ callId: 'c', eventSeq: 0, call: { name: 'read', args: { path: 'a' } } }] })
    await expect(manager.close()).rejects.toThrow()
    await batch?.release(); await batch?.release(); await manager.close()
  } finally { await manager.close().catch(() => {}); await environment.close(); rmWorkspaceSync(cwd) }
})

// Controlled accepted-evidence fixture; this does not claim physical delivery.
it('binds only the originating session, call identity, frozen arguments and capture once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-accepted-bind-')), environment = createProjectInstructionEnvironment(), session = createSession()
  const manager = createMainInstructionManager({ session, environment, cwd, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: async () => {} })
  try {
    await manager.reconcile(); const evidence = manager.capture()!
    session.events.push({ type: 'tool/call', callId: 'c', name: 'read', args: { path: 'a' }, seq: 0 })
    session.events.push({ type: 'model/exchange-accepted', version: 1, exchangeId: 'e', actionId: 'a', attemptId: 't', stepStartSeq: 0, assistantSeq: 0, callSeqs: [0], seq: 1 })
    const batch = manager.succeeded({ evidence, candidate: { instructions: evidence } as never, acceptedSeq: 1,
      outcome: { kind: 'memory-committed', durability: 'nondurable', seqs: [1] }, physicalExecutionReceipt: { actionId: 'a', attemptId: 't' } as never,
      calls: [{ callId: 'c', eventSeq: 0, call: { name: 'read', args: { path: 'a' } } }] })!
    const tools = createToolRegistry(createContext()); tools.register({ name: 'read', description: '', inputSchema: {}, execute: async () => 'value' })
    const invalid = tools.capture({ name: 'read', args: { path: 'a' } }, { session: createSession(), callId: 'c', callEventSeq: 0 })
    expect(() => batch.bind(0, invalid)).toThrow()
    const wrongArgs = tools.capture({ name: 'read', args: { path: 'b' } }, { session, callId: 'c', callEventSeq: 0 })
    expect(() => batch.bind(0, wrongArgs)).toThrow()
    const capture = tools.capture({ name: 'read', args: { path: 'a' } }, { session, callId: 'c', callEventSeq: 0 })
    const origin = batch.bind(0, capture)
    expect(batch.bind(0, capture)).toBe(origin)
    expect(() => batch.bind(0, { ...capture })).toThrow()
    await batch.release(); expect(() => batch.bind(0, capture)).toThrow()
  } finally { await manager.close(); await environment.close(); rmWorkspaceSync(cwd) }
})

// Controlled evidence fixture exercises the genuine manager/source/registry chain; no transport is claimed.
it('authorizes a captured native write under its original issued rules and fences changed rules', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-accepted-source-')), environment = createProjectInstructionEnvironment(), session = createSession(), target = join(cwd, 'file.txt'), rules = join(cwd, 'AGENTS.md')
  await writeFile(target, 'before'); await writeFile(rules, 'old rules')
  let source: import('@i-harness/instructions').InstructionService | undefined
  const create = environment.host.create.bind(environment.host)
  environment.host.create = scope => { source = create(scope); return source }
  const manager = createMainInstructionManager({ session, environment, cwd, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: async () => {} })
  try {
    await manager.reconcile(); const evidence = manager.capture()!
    const args = { path: target, text: 'after' }
    session.events.push({ type: 'tool/call', callId: 'c', name: 'write', args, seq: 0 })
    session.events.push({ type: 'model/exchange-accepted', version: 1, exchangeId: 'e', actionId: 'a', attemptId: 't', stepStartSeq: 0, assistantSeq: 0, callSeqs: [0], seq: 1 })
    const batch = manager.succeeded({ evidence, candidate: { instructions: evidence } as never, acceptedSeq: 1, outcome: { kind: 'memory-committed', durability: 'nondurable', seqs: [1] }, physicalExecutionReceipt: { actionId: 'a', attemptId: 't' } as never, calls: [{ callId: 'c', eventSeq: 0, call: { name: 'write', args } }] })!
    const tools = createToolRegistry(createContext()); for (const tool of createFsTools({ workspace: cwd })) tools.register(tool)
    const capture = tools.capture({ name: 'write', args }, { session, callId: 'c', callEventSeq: 0 }), origin = batch.bind(0, capture)
    await batch.preflight([{ registry: tools, capture, origin }])
    const prepared = await tools.prepareCaptured(capture, undefined, origin)
    await writeFile(rules, 'new rules')
    await vi.waitFor(() => expect(source!.snapshot().complete).toBe(false))
    await expect(tools.dispatch(prepared)).rejects.toMatchObject({ code: 'INSTRUCTIONS_REPLAN_REQUIRED' })
    expect(await readFile(target, 'utf8')).toBe('before')
    await batch.release()
  } finally { await manager.close().catch(() => {}); await environment.close(); rmWorkspaceSync(cwd) }
})

it('keeps the original accepted view pinned across a newer request and executes its exact captured bytes once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-accepted-old-view-')), environment = createProjectInstructionEnvironment(), session = createSession(), target = join(cwd, 'file.txt')
  await writeFile(target, 'before'); await writeFile(join(cwd, 'AGENTS.md'), 'rules')
  const manager = createMainInstructionManager({ session, environment, cwd, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: async () => {} })
  try {
    await manager.reconcile(); const evidence = manager.capture()!, args = { path: target, text: 'captured' }
    session.events.push({ type: 'tool/call', callId: 'c', name: 'write', args, seq: 0 })
    session.events.push({ type: 'model/exchange-accepted', version: 1, exchangeId: 'e', actionId: 'a', attemptId: 't', stepStartSeq: 0, assistantSeq: 0, callSeqs: [0], seq: 1 })
    const batch = manager.succeeded({ evidence, candidate: { instructions: evidence } as never, acceptedSeq: 1, outcome: { kind: 'memory-committed', durability: 'nondurable', seqs: [1] }, physicalExecutionReceipt: { actionId: 'a', attemptId: 't' } as never, calls: [{ callId: 'c', eventSeq: 0, call: { name: 'write', args } }] })!
    const tools = createToolRegistry(createContext()); for (const tool of createFsTools({ workspace: cwd })) tools.register(tool)
    const capture = tools.capture({ name: 'write', args }, { session, callId: 'c', callEventSeq: 0 }), origin = batch.bind(0, capture)
    await batch.preflight([{ registry: tools, capture, origin }]); await manager.reconcile()
    expect(manager.capture()).not.toBe(evidence)
    args.text = 'later mutation'
    expect(await tools.dispatch(await tools.prepareCaptured(capture, undefined, origin))).toMatchObject({ ok: true })
    expect(await readFile(target, 'utf8')).toBe('captured')
    await batch.release()
  } finally { await manager.close().catch(() => {}); await environment.close(); rmWorkspaceSync(cwd) }
})

it.each(['same-scope', 'sibling-scope'] as const)('preflights the whole known rule/code batch: %s', async kind => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-accepted-pair-')), environment = createProjectInstructionEnvironment(), session = createSession()
  const a = join(cwd, 'a'), b = join(cwd, 'b'); await mkdir(a); await mkdir(b)
  const rules = join(a, 'AGENTS.md'), file = join(kind === 'same-scope' ? a : b, 'data.txt')
  await writeFile(rules, 'old rules'); await writeFile(file, 'old data')
  const manager = createMainInstructionManager({ session, environment, cwd, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: async () => {} })
  try {
    await manager.observe({ path: rules, kind: 'file' }); await manager.observe({ path: file, kind: 'file' }); await manager.reconcile()
    const evidence = manager.capture()!, calls = [{ callId: 'rules', args: { path: rules, text: 'new rules' } }, { callId: 'data', args: { path: file, text: 'new data' } }]
    for (const [seq, call] of calls.entries()) session.events.push({ type: 'tool/call', callId: call.callId, name: 'write', args: call.args, seq })
    session.events.push({ type: 'model/exchange-accepted', version: 1, exchangeId: 'e', actionId: 'a', attemptId: 't', stepStartSeq: 0, assistantSeq: 0, callSeqs: [0, 1], seq: 2 })
    const batch = manager.succeeded({ evidence, candidate: { instructions: evidence } as never, acceptedSeq: 2, outcome: { kind: 'memory-committed', durability: 'nondurable', seqs: [2] }, physicalExecutionReceipt: { actionId: 'a', attemptId: 't' } as never, calls: calls.map((call, eventSeq) => ({ callId: call.callId, eventSeq, call: { name: 'write', args: call.args } })) })!
    const tools = createToolRegistry(createContext()); for (const tool of createFsTools({ workspace: cwd })) tools.register(tool)
    const entries = calls.map((call, index) => { const capture = tools.capture({ name: 'write', args: call.args }, { session, callId: call.callId, callEventSeq: index }); return { registry: tools, capture, origin: batch.bind(index, capture) } })
    if (kind === 'same-scope') {
      await expect(batch.preflight(entries)).rejects.toMatchObject({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', data: { splitRequired: true } })
      expect(await readFile(rules, 'utf8')).toBe('old rules'); expect(await readFile(file, 'utf8')).toBe('old data')
    } else {
      await batch.preflight(entries)
      for (const entry of entries) await tools.dispatch(await tools.prepareCaptured(entry.capture, undefined, entry.origin))
      expect(await readFile(rules, 'utf8')).toBe('new rules'); expect(await readFile(file, 'utf8')).toBe('new data')
    }
    await batch.release()
  } finally { await manager.close().catch(() => {}); await environment.close(); rmWorkspaceSync(cwd) }
})

it('rejects canonical alias targets in a known batch before any body', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-accepted-alias-')), environment = createProjectInstructionEnvironment(), session = createSession()
  const actual = join(cwd, 'actual'), alias = join(cwd, 'alias'); await mkdir(actual); await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const paths = [join(actual, 'data'), join(alias, 'data')]; await writeFile(paths[0]!, 'old')
  const manager = createMainInstructionManager({ session, environment, cwd, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: async () => {} })
  try {
    for (const path of paths) await manager.observe({ path, kind: 'file' }); await manager.reconcile()
    const evidence = manager.capture()!, calls = paths.map((path, index) => ({ callId: `c${index}`, args: { path, text: `new${index}` } }))
    for (const [seq, call] of calls.entries()) session.events.push({ type: 'tool/call', callId: call.callId, name: 'write', args: call.args, seq })
    session.events.push({ type: 'model/exchange-accepted', version: 1, exchangeId: 'e', actionId: 'a', attemptId: 't', stepStartSeq: 0, assistantSeq: 0, callSeqs: [0, 1], seq: 2 })
    const batch = manager.succeeded({ evidence, candidate: { instructions: evidence } as never, acceptedSeq: 2, outcome: { kind: 'memory-committed', durability: 'nondurable', seqs: [2] }, physicalExecutionReceipt: { actionId: 'a', attemptId: 't' } as never, calls: calls.map((call, eventSeq) => ({ callId: call.callId, eventSeq, call: { name: 'write', args: call.args } })) })!
    const tools = createToolRegistry(createContext()); for (const tool of createFsTools({ workspace: cwd })) tools.register(tool)
    const entries = calls.map((call, index) => { const capture = tools.capture({ name: 'write', args: call.args }, { session, callId: call.callId, callEventSeq: index }); return { registry: tools, capture, origin: batch.bind(index, capture) } })
    await expect(batch.preflight(entries)).rejects.toMatchObject({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', data: { splitRequired: true } })
    expect(await readFile(paths[0]!, 'utf8')).toBe('old')
    await batch.release()
  } finally { await manager.close().catch(() => {}); await environment.close(); rmWorkspaceSync(cwd) }
})

it('settles a real owned rule write and exposes those bytes in the next request', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-owned-rules-')), environment = createProjectInstructionEnvironment(), session = createSession(), target = join(cwd, 'AGENTS.md')
  await writeFile(target, 'old rules')
  const manager = createMainInstructionManager({ session, environment, cwd, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: async () => {} })
  try {
    await manager.reconcile(); const evidence = manager.capture()!, args = { path: target, text: 'new owned rules' }
    session.events.push({ type: 'tool/call', callId: 'c', name: 'write', args, seq: 0 })
    session.events.push({ type: 'model/exchange-accepted', version: 1, exchangeId: 'e', actionId: 'a', attemptId: 't', stepStartSeq: 0, assistantSeq: 0, callSeqs: [0], seq: 1 })
    const batch = manager.succeeded({ evidence, candidate: { instructions: evidence } as never, acceptedSeq: 1, outcome: { kind: 'memory-committed', durability: 'nondurable', seqs: [1] }, physicalExecutionReceipt: { actionId: 'a', attemptId: 't' } as never, calls: [{ callId: 'c', eventSeq: 0, call: { name: 'write', args } }] })!
    const tools = createToolRegistry(createContext()); for (const tool of createFsTools({ workspace: cwd })) tools.register(tool)
    const capture = tools.capture({ name: 'write', args }, { session, callId: 'c', callEventSeq: 0 }), origin = batch.bind(0, capture)
    await batch.preflight([{ registry: tools, capture, origin }]); expect(await tools.dispatch(await tools.prepareCaptured(capture, undefined, origin))).toMatchObject({ ok: true })
    expect(await readFile(target, 'utf8')).toBe('new owned rules')
    await batch.release(); await manager.reconcile(); expect(manager.text()).toContain('new owned rules')
  } finally { await manager.close().catch(() => {}); await environment.close(); rmWorkspaceSync(cwd) }
})

it('a required registry accepts only the original manager-owned call capability', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-required-origin-')), environment = createProjectInstructionEnvironment(), session = createSession(), target = join(cwd, 'file')
  await writeFile(target, 'before')
  const manager = createMainInstructionManager({ session, environment, cwd, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: async () => {} })
  try {
    await manager.reconcile(); const evidence = manager.capture()!, args = { path: target, text: 'after' }
    session.events.push({ type: 'tool/call', callId: 'c', name: 'write', args, seq: 0 })
    session.events.push({ type: 'model/exchange-accepted', version: 1, exchangeId: 'e', actionId: 'a', attemptId: 't', stepStartSeq: 0, assistantSeq: 0, callSeqs: [0], seq: 1 })
    const batch = manager.succeeded({ evidence, candidate: { instructions: evidence } as never, acceptedSeq: 1, outcome: { kind: 'memory-committed', durability: 'nondurable', seqs: [1] }, physicalExecutionReceipt: { actionId: 'a', attemptId: 't' } as never, calls: [{ callId: 'c', eventSeq: 0, call: { name: 'write', args } }] })!
    const tools = createToolRegistry(createContext(), { instructionsRequired: true, instructionOriginVerifier: isOriginalAcceptedInstructionOrigin })
    for (const tool of createFsTools({ workspace: cwd })) tools.register(tool)
    const fake = tools.capture({ name: 'write', args }, { session, callId: 'c', callEventSeq: 0 })
    expect(() => tools.bindNativeInstructions(fake, { kind: 'accepted-instruction-call' }, { assertCurrent() {}, before() {}, settle() {} })).toThrow()
    await expect(tools.prepare({ name: 'write', args }, undefined, { session, callId: 'c', callEventSeq: 0 })).rejects.toThrow()
    const capture = tools.capture({ name: 'write', args }, { session, callId: 'c', callEventSeq: 0 }), origin = batch.bind(0, capture)
    await batch.preflight([{ registry: tools, capture, origin }])
    expect(await tools.dispatch(await tools.prepareCaptured(capture, undefined, origin))).toMatchObject({ ok: true })
    expect(await readFile(target, 'utf8')).toBe('after')
    await batch.release()
  } finally { await manager.close().catch(() => {}); await environment.close(); rmWorkspaceSync(cwd) }
})
