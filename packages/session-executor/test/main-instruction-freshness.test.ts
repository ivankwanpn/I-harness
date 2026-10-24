import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { InstructionService } from '@i-harness/instructions'
import type { ModelClient } from '@i-harness/llm-seam'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createSessionService } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'

it('a same-text dependency change during actual preparation rebuilds before physical issue without another text record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-fresh-instructions-')); await writeFile(join(root, 'AGENTS.md'), 'UNCHANGED_CURRENT_TEXT')
  const environment = createProjectInstructionEnvironment(), sources: InstructionService[] = [], originalCreate = environment.host.create.bind(environment.host)
  environment.host.create = scope => { const source = originalCreate(scope); sources.push(source); return source }
  const bodies: string[] = [], server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; bodies.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const client = createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: `http://127.0.0.1:${address.port}` })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let preparations = 0
  const model: ModelClient = { ...client, async prepare(request) { const prepared = await client.prepare!(request); if (++preparations === 1) { entered.resolve(); await release.promise }; return prepared } }
  const service = createSessionService({ workspace: root, model, contextWindow: 100000, instructionEnvironment: environment, codeMode: { mode: 'off' } })
  const run = service.submit('fresh', 'causal held preparation', AbortSignal.timeout(10000)); void run.catch(() => {})
  try {
    await entered.promise
    const assembly = await service.assemblyFor('fresh'), events = assembly.session.events.length
    for (let index = 0; index < 3; index++) assembly.agent.contextBudget!()
    expect(assembly.session.events).toHaveLength(events); expect(bodies).toEqual([])
    await writeFile(join(root, 'CLAUDE.md'), 'SHADOWED_DEPENDENCY_CHANGE')
    await vi.waitFor(() => expect(sources[0]!.snapshot().complete).toBe(false))
    release.resolve(); await run
    expect(preparations).toBe(2); expect(bodies).toHaveLength(1)
    expect(bodies[0]!.split('UNCHANGED_CURRENT_TEXT')).toHaveLength(2)
    expect(bodies[0]).not.toContain('SHADOWED_DEPENDENCY_CHANGE')
    expect(assembly.session.events.filter(event => event.type === 'runtime/context')).toHaveLength(1)
  } finally { release.resolve(); await run.catch(() => {}); await service.close(); await environment.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmWorkspaceSync(root) }
})
