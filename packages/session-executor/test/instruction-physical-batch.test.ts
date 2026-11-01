import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createSessionService } from '../src/index.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { rmWorkspaceSync } from './helpers.ts'

const frame = (calls: { id: string; path: string; text: string }[]) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((c, index) => ({ index, id: c.id, function: { name: 'write', arguments: JSON.stringify({ path: c.path, text: c.text }) } })) }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
const finalFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`

it.each(['owned-rule', 'mixed-batch'] as const)('uses the real original receipt for %s and sends the next logical request', async mode => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-physical-instruction-')), rules = join(cwd, 'AGENTS.md'), target = join(cwd, 'data.txt')
  await writeFile(rules, 'old rule'); await writeFile(target, 'old data')
  const calls = [{ id: 'rule', path: rules, text: 'new rule' }, ...(mode === 'mixed-batch' ? [{ id: 'data', path: target, text: 'new data' }] : [])]
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(frame(calls)) }, async response => { response.end(finalFrame) }])
  const environment = createProjectInstructionEnvironment()
  const service = createSessionService({ workspace: cwd, instructionEnvironment: environment, model: createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), contextWindow: 100000, codeMode: { mode: 'off' }, approveAll: true })
  try {
    await service.submit('owned', 'update the file', AbortSignal.timeout(15000))
    expect(server.requests).toHaveLength(2); expect(server.errors).toEqual([])
    const events = service.liveSession('owned')!.events, results = events.filter(event => event.type === 'tool/result')
    if (mode === 'owned-rule') {
      expect(await readFile(rules, 'utf8')).toBe('new rule')
      expect(JSON.stringify(server.requests[1]!.body)).toContain('new rule')
      expect(results).toHaveLength(1)
    } else {
      expect(await readFile(rules, 'utf8')).toBe('old rule'); expect(await readFile(target, 'utf8')).toBe('old data')
      expect(results).toHaveLength(2)
      expect(JSON.stringify(server.requests[1]!.body)).toContain('INSTRUCTIONS_REPLAN_REQUIRED')
      expect(events.filter(event => event.type === 'tool/dispatch')).toEqual([])
    }
  } finally { await service.close(); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('discovers a later unseen target even when an earlier patch is malformed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-physical-malformed-')), nested = join(cwd, 'nested'), target = join(nested, 'data.txt')
  await mkdir(nested); await writeFile(join(cwd, 'AGENTS.md'), 'root rule'); await writeFile(join(nested, 'AGENTS.md'), 'nested new rule'); await writeFile(target, 'unchanged')
  const calls = [{ index: 0, id: 'bad', function: { name: 'apply_patch', arguments: JSON.stringify({ patch_content: 'bad patch' }) } }, { index: 1, id: 'later', function: { name: 'write', arguments: JSON.stringify({ path: target, text: 'unsafe' }) } }]
  const first = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(first) }, async response => { response.end(finalFrame) }]), environment = createProjectInstructionEnvironment()
  const service = createSessionService({ workspace: cwd, instructionEnvironment: environment, model: createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), contextWindow: 100000, codeMode: { mode: 'off' }, approveAll: true })
  try {
    await service.submit('owned', 'handle both', AbortSignal.timeout(15000))
    expect(server.requests).toHaveLength(2); expect(server.errors).toEqual([])
    const next = JSON.stringify(server.requests[1]!.body)
    expect(next).toContain('FS_EDIT_NOT_FOUND'); expect(next).toContain('INSTRUCTIONS_REPLAN_REQUIRED'); expect(next).toContain('nested new rule')
    expect(await readFile(target, 'utf8')).toBe('unchanged')
    expect(service.liveSession('owned')!.events.filter(event => event.type === 'tool/dispatch')).toEqual([])
  } finally { await service.close(); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('replans after a held dispatch hook observes a changed instruction source', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-physical-held-')), rules = join(cwd, 'AGENTS.md'), target = join(cwd, 'data.txt')
  await writeFile(rules, 'old rule'); await writeFile(target, 'old data')
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(frame([{ id: 'write', path: target, text: 'unsafe' }])) }, async response => { response.end(finalFrame) }]), environment = createProjectInstructionEnvironment()
  let source: import('@i-harness/instructions').InstructionService | undefined
  const create = environment.host.create.bind(environment.host); environment.host.create = scope => { source = create(scope); return source }
  const service = createSessionService({ workspace: cwd, instructionEnvironment: environment, model: createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), contextWindow: 100000, codeMode: { mode: 'off' }, approveAll: true })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    const assembly = await service.assemblyFor('owned')
    assembly.ctx.onCascade('tools/execute', async (_input, next) => { entered.resolve(); await release.promise; return next() })
    const work = service.submit('owned', 'update', AbortSignal.timeout(15000)); void work.catch(() => {})
    await entered.promise; await writeFile(rules, 'new rule')
    await vi.waitFor(() => expect(source!.snapshot().complete).toBe(false))
    release.resolve(); await work
    expect(await readFile(target, 'utf8')).toBe('old data')
    expect(server.requests).toHaveLength(2)
    const next = JSON.stringify(server.requests[1]!.body)
    expect(next).toContain('INSTRUCTIONS_REPLAN_REQUIRED'); expect(next).toContain('new rule')
  } finally { release.resolve(); await service.close(); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})
