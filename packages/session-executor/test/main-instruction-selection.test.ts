import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'

const done = `data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
it.each(['newer-read', 'failed-issue'] as const)('physical %s consumes only its captured pending read generation', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-selection-')), paths = ['a', 'b', 'c'].map(name => join(root, name))
  await writeFile(join(root, 'AGENTS.md'), 'SELECTION_REQUIRED')
  for (const [index, path] of paths.entries()) { await mkdir(path); await writeFile(join(path, 'AGENTS.md'), `SELECTION_${index}_RULE`) }
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), bodies: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; bodies.push(body)
    if (bodies.length === 1) { entered.resolve(); await release.promise; if (mode === 'failed-issue') { response.destroy(); return } }
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(done)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const service = createSessionService({ workspace: root, model: createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: `http://127.0.0.1:${address.port}` }), contextWindow: 100000, codeMode: { mode: 'off' } })
  let first: Promise<unknown> | undefined
  try {
    const assembly = await service.assemblyFor('selection')
    const list = async (path: string) => {
      const prepared = await assembly.tools.prepare({ name: 'list_dir', args: { path } }, undefined, { session: assembly.session, callId: 'real-list' })
      return assembly.tools.dispatch(prepared)
    }
    expect(await list(paths[0]!)).toMatchObject({ instruction_scope: { status: 'queued' } })
    first = assembly.agent.followup('captured first read wave', AbortSignal.timeout(10000)); void first.catch(() => {})
    await entered.promise
    if (mode === 'newer-read') expect(await list(paths[1]!)).toMatchObject({ instruction_scope: { status: 'queued' } })
    release.resolve()
    if (mode === 'failed-issue') { await expect(first).rejects.toThrow(); await list(paths[1]!) }
    else await first
    await assembly.agent.followup('unknown continuation keeps pending wave')
    expect(bodies[1]).toContain('SELECTION_0_RULE'); expect(bodies[1]).toContain('SELECTION_1_RULE')
    await list(paths[2]!)
    await assembly.agent.followup('a new wave retires prior incidental targets')
    expect(bodies).toHaveLength(3)
    expect(bodies[2]).toContain('SELECTION_2_RULE')
    expect(bodies[2]).not.toContain('SELECTION_0_RULE'); expect(bodies[2]).not.toContain('SELECTION_1_RULE')
    expect(bodies.every(body => body.split('SELECTION_REQUIRED').length === 2)).toBe(true)
  } finally { release.resolve(); await first?.catch(() => {}); await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmWorkspaceSync(root) }
})

it('cold JSONL main preserves original current history and sends only freshly observed source text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-cold-')), store = join(root, 'sessions'), bodies: string[] = []
  await writeFile(join(root, 'AGENTS.md'), 'COLD_FIRST_SOURCE')
  const server = createServer(async (request, response) => { let body = ''; for await (const chunk of request) body += chunk; bodies.push(body); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(done) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const model = createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: `http://127.0.0.1:${address.port}` })
  let coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } }), service = createSessionService({ workspace: root, coordinator, model, contextWindow: 100000, codeMode: { mode: 'off' } })
  const { id } = await coordinator.create()
  try {
    await service.submit(id, 'first persisted main', new AbortController().signal)
    await service.close(); await coordinator.close()
    await writeFile(join(root, 'AGENTS.md'), 'COLD_FRESH_SOURCE')
    coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
    service = createSessionService({ workspace: root, coordinator, model, contextWindow: 100000, codeMode: { mode: 'off' } })
    await service.submit(id, 'new cold genuine task', new AbortController().signal)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]!.split('COLD_FRESH_SOURCE')).toHaveLength(2); expect(bodies[1]).not.toContain('COLD_FIRST_SOURCE')
    const contexts = (await createJsonlBackend(store).read(id)).events.filter(event => event.type === 'runtime/context')
    expect(contexts).toHaveLength(2)
    expect(JSON.stringify(contexts[0])).toContain('COLD_FIRST_SOURCE'); expect(JSON.stringify(contexts[1])).toContain('COLD_FRESH_SOURCE')
  } finally { await service.close(); await coordinator.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmWorkspaceSync(root) }
})
