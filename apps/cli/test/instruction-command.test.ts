import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionService } from '@i-harness/session-executor'
import { runCommand } from '@i-harness/interaction'
import { createOpenAICompatibleClient } from '../../../packages/llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../../packages/core-agent/test/helpers/provider-loopback.ts'
import { registerInstructionCommands } from '../src/run.ts'

it('uses the actual live assembly for status and refresh without another model request', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ih-cli-instruction-')); await writeFile(join(workspace, 'AGENTS.md'), 'CLI_INSTRUCTION_RULE')
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), service = createSessionService({ workspace, model })
  try {
    const assembly = await service.assemblyFor('live'); registerInstructionCommands(assembly)
    const before = await runCommand(assembly.ctx, 'instruction-status', '{}'); if (before.kind !== 'reply') throw new Error('missing reply')
    expect(JSON.parse(before.text).state).toBe('not-published'); expect(server.requests).toHaveLength(0)
    await service.submit('live', 'hello', new AbortController().signal)
    const status = await runCommand(assembly.ctx, 'instruction-status', '{}'); if (status.kind !== 'reply') throw new Error('missing reply')
    expect(JSON.parse(status.text)).toMatchObject({ state: 'ready', publication: { sources: [{ path: join(workspace, 'AGENTS.md') }] } })
    const text = await runCommand(assembly.ctx, 'instruction-status', '{"format":"text"}'); if (text.kind !== 'reply') throw new Error('missing reply')
    expect(text.text).toContain('AGENTS.md'); expect(text.text).toContain('ready')
    const refresh = await runCommand(assembly.ctx, 'instruction-refresh', '{}'); if (refresh.kind !== 'reply') throw new Error('missing reply')
    expect(JSON.parse(refresh.text).state).toBe('ready'); expect(server.requests).toHaveLength(1)
  } finally { await service.close(); await server.close(); await rm(workspace, { recursive: true, force: true }) }
}, 15000)
