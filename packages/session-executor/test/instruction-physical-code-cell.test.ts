import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createSession } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createFsTools } from '@i-harness/fs'
import { createAgent } from '@i-harness/core-agent'
import { createRuntimeContext } from '@i-harness/runtime-context'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { registerCodeMode } from '../../code-mode/src/register.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createMainInstructionManager, isOriginalAcceptedInstructionOrigin, retainOriginalInstructionCell } from '../src/context/instructions/manager.ts'
import { rmWorkspaceSync } from './helpers.ts'

const callFrame = (id: string, name: string, args: unknown) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
const finalFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`

it('uses the original physical code_exec evidence after yield and replans before guest catch', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-physical-cell-')), rules = join(cwd, 'AGENTS.md'), target = join(cwd, 'file')
  await writeFile(rules, 'old rules'); await writeFile(target, 'before')
  const environment = createProjectInstructionEnvironment(), session = createSession(), sources: import('@i-harness/instructions').InstructionService[] = []
  const create = environment.host.create.bind(environment.host); environment.host.create = scope => { const source = create(scope); sources.push(source); return source }
  const runtimeContext = createRuntimeContext(session)
  const manager = createMainInstructionManager({ session, environment, cwd, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true, publish: (signal, retain) => runtimeContext.render(signal, retain) })
  runtimeContext.registerSection('instructions', manager.text)
  const ctx = createContext(), tools = createToolRegistry(ctx, { instructionsRequired: true, instructionOriginVerifier: isOriginalAcceptedInstructionOrigin, instructionCellRetainer: retainOriginalInstructionCell })
  for (const tool of createFsTools({ workspace: cwd })) tools.register(tool)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  tools.register({ name: 'gate', description: '', inputSchema: {}, execute: async () => { entered.resolve(); await release.promise; return 'ready' } })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: 'mixed' } })
  let cellId = ''
  const server = await createLoopbackProvider('/v1/chat/completions', [
    async response => { const code = `await tools.gate({}); try { await tools.write(${JSON.stringify({ path: target, text: 'unsafe' })}) } catch { text('caught'); store('bad', true) }`; response.end(callFrame('outer', 'code_exec', { code, yield_time_ms: 0 })) },
    async (response, request) => {
      const messages = request.body.messages as { role: string; content: string }[]
      const tool = messages.findLast(message => message.role === 'tool')!; cellId = JSON.parse(tool.content).cell_id
      await entered.promise; await writeFile(rules, 'new rules'); await vi.waitFor(() => expect(sources[0]!.snapshot().complete).toBe(false)); release.resolve()
      response.end(callFrame('wait', 'code_wait', { cell_id: cellId, yield_time_ms: 5000 }))
    },
    async response => { response.end(finalFrame) },
  ])
  const agent = createAgent(ctx, { session, tools, model: createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), systemPrompt: 's', requestContext: manager })
  try {
    expect(await agent.run('work', AbortSignal.timeout(15000))).toMatchObject({ finalText: 'done' })
    expect(server.requests).toHaveLength(3); expect(server.errors).toEqual([])
    expect(await readFile(target, 'utf8')).toBe('before'); expect(session.events.filter(event => event.type === 'code/store')).toEqual([])
    expect(session.events.filter(event => event.type === 'code/cell' && event.cellId === cellId && event.state === 'failed')).toMatchObject([{ instructionReplan: { code: 'INSTRUCTIONS_REPLAN_REQUIRED' } }])
    expect(JSON.stringify(server.requests[2]!.body)).toContain('INSTRUCTIONS_REPLAN_REQUIRED')
    expect(JSON.stringify(server.requests[2]!.body)).toContain('new rules')
  } finally { release.resolve(); await mount.dispose().catch(() => {}); await runtimeContext.close(); await manager.close().catch(() => {}); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})
