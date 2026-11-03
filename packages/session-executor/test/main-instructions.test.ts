import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createOpenAIClient } from '../../llm-openai/src/index.ts'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createSessionService } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'

const ambient = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => ambient.path }))

it.each((['chat', 'responses', 'anthropic'] as const).flatMap(route => (['project', 'saved', 'disabled', 'zero'] as const).map(mode => ({ route, mode }))))('actual assembled $route main scopes instructions with $mode policy', async ({ route, mode }) => {
  const disabled = mode === 'disabled' || mode === 'zero'
  const root = await mkdtemp(join(tmpdir(), 'ih-main-instructions-'))
  const workspace = join(root, 'project'); ambient.path = join(root, 'ambient')
  await mkdir(workspace); await mkdir(ambient.path)
  await writeFile(join(root, 'AGENTS.md'), 'OUTSIDE_ROOT_SENTINEL')
  await writeFile(join(ambient.path, 'AGENTS.md'), 'AMBIENT_HOME_SENTINEL')
  await writeFile(join(workspace, 'AGENTS.md'), 'PROJECT_CURRENT_SENTINEL')
  await writeFile(join(workspace, 'CLAUDE.md'), 'SHADOWED_SENTINEL')
  const profile = join(root, 'native'); await mkdir(profile)
  await writeFile(join(profile, 'AGENTS.md'), 'SELECTED_NATIVE_SENTINEL')
  const settingsPath = join(profile, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ instructions: { enabled: mode !== 'disabled', maxBytes: mode === 'zero' ? 0 : 24000 } }))
  const bodies: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    bodies.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = route === 'chat' ? [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]
      : route === 'responses' ? [{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { status: 'completed' } }]
        : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'message_stop' }]
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (route === 'chat' ? 'data: [DONE]\n\n' : ''))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const service = createSessionService({ workspace, coordinator,
    ...(mode !== 'project' ? { instructionSettingsPath: settingsPath } : {}),
    model: (route === 'chat' ? createOpenAICompatibleClient : route === 'responses' ? createOpenAIClient : createAnthropicClient)({ apiKey: 'owned-loopback', model: 'fixture', baseUrl: `http://127.0.0.1:${address.port}` }),
    contextWindow: 100000, codeMode: { mode: 'off' }, approveAll: true,
  })
  try {
    await service.submit(id, 'read instructions', new AbortController().signal)
    expect(bodies).toHaveLength(1)
    if (disabled) expect(bodies[0]).not.toContain('PROJECT_CURRENT_SENTINEL')
    else { expect(bodies[0]).toContain('PROJECT_CURRENT_SENTINEL'); expect(bodies[0]!.split('PROJECT_CURRENT_SENTINEL')).toHaveLength(2) }
    expect(bodies[0]).not.toContain('SHADOWED_SENTINEL')
    expect(bodies[0]).not.toContain('OUTSIDE_ROOT_SENTINEL')
    expect(bodies[0]).not.toContain('AMBIENT_HOME_SENTINEL')
    if (mode === 'saved') expect(bodies[0]!.split('SELECTED_NATIVE_SENTINEL')).toHaveLength(2)
    else expect(bodies[0]).not.toContain('SELECTED_NATIVE_SENTINEL')
  } finally {
    await service.close(); await coordinator.close()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    rmWorkspaceSync(root)
  }
})
