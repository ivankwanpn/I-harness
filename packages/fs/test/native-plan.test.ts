import { expect, it, vi } from 'vitest'
import * as patchModule from '../src/patch.ts'
import { createContext } from '../../core-plugin/src/index.ts'
import { createToolRegistry, isNativePlanValidationError, instructionReplan, instructionReplanDisposition } from '@i-harness/core-tools'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsTools } from '../src/index.ts'

it.each([0, 1, 2])('refuses an overlong lexical patch effect label before earlier effects (hunk=%s)', async longIndex => {
  const root = await mkdtemp(join(tmpdir(), 'ih-patch-label-')), names = ['a.txt', 'b.txt', 'c.txt'], paths = names.map(name => join(root, name))
  const label = './'.repeat(2050) + names[longIndex]!, labels = names.map((name, i) => i === longIndex ? label : name)
  try {
    for (const path of paths) await writeFile(path, 'old\n')
    const ctx = createContext(), registry = createToolRegistry(ctx)
    let bodies = 0, boundaries = 0
    ctx.onCascade('tools/execute', async (_input, next) => { bodies++; return next() })
    for (const tool of createFsTools({ workspace: root })) registry.register(tool)
    const patch = ['*** Begin Patch', ...labels.flatMap(path => [`*** Update File: ${path}`, '@@', '-old', '+new']), '*** End Patch', ''].join('\n')
    let failure: unknown
    try {
      const capture = registry.capture({ name: 'apply_patch', args: { patch_content: patch } }), origin = Object.freeze({ kind: 'accepted-instruction-call' as const })
      registry.bindNativeInstructions(capture, origin, { assertCurrent() {}, before(boundary) { boundaries++; if (boundary.target === paths[1] && boundary.operation === 'rename') throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'changed-dependency', currentFingerprint: '' }) }, settle() {} })
      await registry.dispatch(await registry.prepareCaptured(capture, undefined, origin))
    } catch (error) { failure = error }
    expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(['old\n', 'old\n', 'old\n'])
    expect([bodies, boundaries]).toEqual([0, 0])
    expect(isNativePlanValidationError(failure)).toBe(true)
    expect((failure as { output: unknown }).output).toEqual({ code: 'FS_TOO_LARGE', error: `patch path exceeds the 4096-character effect label limit: ${label}` })
    expect(await readdir(root)).toEqual(names)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('captures a write target before dispatch and writes the captured bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-plan-'))
  try {
    const registry = createToolRegistry(createContext())
    for (const tool of createFsTools({ workspace: root })) registry.register(tool)
    const args = { path: 'out.txt', text: 'original' }, capture = registry.capture({ name: 'write', args })
    expect(registry.inspectCapture(capture).native?.targets).toEqual([{ path: join(root, 'out.txt'), kind: 'file', mode: 'mutate' }])
    args.text = 'changed'
    await registry.dispatch(await registry.prepareCaptured(capture))
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('original')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('classifies expected write path failure without starting a body', () => {
  const registry = createToolRegistry(createContext())
  for (const tool of createFsTools({ workspace: process.cwd() })) registry.register(tool)
  try { registry.capture({ name: 'write', args: { path: '../outside', text: 'x' } }); throw new Error('expected capture failure') }
  catch (error) { expect(isNativePlanValidationError(error)).toBe(true); expect((error as { output: { code: string } }).output.code).toBe('FS_NOT_FOUND') }
})

it('captures edit and patch targets before running their original bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-edit-plan-'))
  try {
    const registry = createToolRegistry(createContext())
    for (const tool of createFsTools({ workspace: root })) registry.register(tool)
    const target = join(root, 'file.txt'); await writeFile(target, 'old\n')
    const edit = registry.capture({ name: 'edit', args: { path: 'file.txt', old_string: 'old', new_string: 'middle' } })
    expect(registry.inspectCapture(edit).native?.targets).toEqual([{ path: target, kind: 'file', mode: 'mutate' }])
    await registry.dispatch(await registry.prepareCaptured(edit))
    expect(await readFile(target, 'utf8')).toBe('middle\n')
    const patch = registry.capture({ name: 'apply_patch', args: { patch_content: '*** Begin Patch\n*** Update File: file.txt\n@@\n-middle\n+new\n*** End Patch\n' } })
    expect(registry.inspectCapture(patch).native?.targets).toEqual([{ path: target, kind: 'file', mode: 'mutate' }])
    await registry.dispatch(await registry.prepareCaptured(patch))
    expect(await readFile(target, 'utf8')).toBe('new\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('captures read and directory targets and preserves their original output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-read-plan-'))
  try {
    await writeFile(join(root, 'file.txt'), 'hello')
    const registry = createToolRegistry(createContext())
    for (const tool of createFsTools({ workspace: root })) registry.register(tool)
    const read = registry.capture({ name: 'read', args: { path: 'file.txt' } })
    expect(registry.inspectCapture(read).native?.targets).toEqual([{ path: join(root, 'file.txt'), kind: 'file', mode: 'read' }])
    expect(await registry.dispatch(await registry.prepareCaptured(read))).toMatchObject({ content: 'hello' })
    const list = registry.capture({ name: 'list_dir', args: { path: '.' } })
    expect(registry.inspectCapture(list).native?.targets).toEqual([{ path: root, kind: 'directory', mode: 'read' }])
    expect(await registry.dispatch(await registry.prepareCaptured(list))).toMatchObject({ entries: ['file.txt'] })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps the standalone registry execute soft-failure contract for invalid paths', async () => {
  const registry = createToolRegistry(createContext())
  for (const tool of createFsTools({ workspace: process.cwd() })) registry.register(tool)
  expect(await registry.execute({ name: 'write', args: { path: '../outside', text: 'x' } })).toMatchObject({ name: 'write', output: { code: 'FS_NOT_FOUND' } })
})

it('executes the captured patch after the workspace setting changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-patch-plan-')), other = await mkdtemp(join(tmpdir(), 'ih-patch-other-'))
  try {
    await writeFile(join(root, 'file.txt'), 'old\n'); await writeFile(join(other, 'file.txt'), 'other\n')
    const deps = { workspace: root }, registry = createToolRegistry(createContext())
    for (const tool of createFsTools(deps)) registry.register(tool)
    const capture = registry.capture({ name: 'apply_patch', args: { patch_content: '*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n*** End Patch\n' } })
    deps.workspace = other
    await registry.dispatch(await registry.prepareCaptured(capture))
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('new\n')
    expect(await readFile(join(other, 'file.txt'), 'utf8')).toBe('other\n')
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }) }
})

it('parses a patch once across capture and dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-parse-once-'))
  const parser = vi.spyOn(patchModule, 'parsePatch')
  try {
    const registry = createToolRegistry(createContext())
    for (const tool of createFsTools({ workspace: root })) registry.register(tool)
    const capture = registry.capture({ name: 'apply_patch', args: { patch_content: '*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\n' } })
    await registry.dispatch(await registry.prepareCaptured(capture))
    expect(parser).toHaveBeenCalledTimes(1)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello\n')
  } finally { parser.mockRestore(); await rm(root, { recursive: true, force: true }) }
})

it('returns a truthful dispatched replan when an atomic edit is fenced after a temp write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-edit-replan-')), target = join(root, 'file.txt')
  try {
    await writeFile(target, 'old')
    const registry = createToolRegistry(createContext()); for (const tool of createFsTools({ workspace: root })) registry.register(tool)
    const capture = registry.capture({ name: 'edit', args: { path: target, old_string: 'old', new_string: 'new' } }), origin = Object.freeze({ kind: 'accepted-instruction-call' as const })
    registry.bindNativeInstructions(capture, origin, { assertCurrent() {}, before(boundary) { if (boundary.operation === 'rename') throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'changed-dependency', currentFingerprint: 'current' }) }, settle() {} })
    const prepared = await registry.prepareCaptured(capture, undefined, origin), result = await registry.dispatch(prepared)
    expect(result).toMatchObject({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', effectsUnknown: [target] })
    expect(instructionReplanDisposition(prepared)).toMatchObject({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', effectsUnknown: [target] })
    expect(await readFile(target, 'utf8')).toBe('old'); expect(await readdir(root)).toEqual(['file.txt'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('preserves applied patch hunks and unknown partial effects when a later rename replans (boundedLexical=%s)', async boundedLexical => {
  const root = await mkdtemp(join(tmpdir(), 'ih-patch-replan-')), paths = ['a.txt', 'b.txt', 'c.txt'].map(name => join(root, name))
  try {
    for (const path of paths) await writeFile(path, 'old\n')
    const registry = createToolRegistry(createContext()); for (const tool of createFsTools({ workspace: root })) registry.register(tool)
    const firstLabel = boundedLexical ? './'.repeat(2045) + 'a.txt' : 'a.txt'
    const patch = ['*** Begin Patch', ...[firstLabel, 'b.txt', 'c.txt'].flatMap(path => [`*** Update File: ${path}`, '@@', '-old', '+new']), '*** End Patch', ''].join('\n')
    const capture = registry.capture({ name: 'apply_patch', args: { patch_content: patch } }), origin = Object.freeze({ kind: 'accepted-instruction-call' as const })
    registry.bindNativeInstructions(capture, origin, { assertCurrent() {}, before(boundary) { if (boundary.target === paths[1] && boundary.operation === 'rename') throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'changed-dependency', currentFingerprint: 'current' }) }, settle() {} })
    const prepared = await registry.prepareCaptured(capture, undefined, origin), output = await registry.dispatch(prepared)
    expect(output).toMatchObject({ ok: false, applied: [{ path: firstLabel }], instruction_replan: { applied: [firstLabel], effectsUnknown: ['b.txt'], notApplied: ['c.txt'] } })
    expect(instructionReplanDisposition(prepared)).toMatchObject({ applied: [firstLabel], effectsUnknown: ['b.txt'], notApplied: ['c.txt'] })
    expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(['new\n', 'old\n', 'old\n'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
