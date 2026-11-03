import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createFsWatchService, type FsWatchService } from '@i-harness/fs-watch'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createInstructionEnvironment, createSessionService } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'

it('actual accepted read result survives original IA close failure and the same service retries without dispatch replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-real-close-')), workspace = join(root, 'workspace'), child = join(workspace, 'child'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await mkdir(child); await writeFile(join(workspace, 'AGENTS.md'), 'ORIGINAL_ROOT_RULE'); await writeFile(join(child, 'AGENTS.md'), 'RETIRED_CHILD_RULE')
  await writeFile(settingsPath, JSON.stringify({ instructions: { enabled: true, maxBytes: 24000, globalSources: [] } }))
  const actualWatch = createFsWatchService(), originalFault = Error('actual original IA lease close fault'); let closeAttempts = 0, injected = false
  const shared: FsWatchService = { acquire(options) {
    const lease = actualWatch.acquire(options), close = lease.close.bind(lease), instruction = !options.roots.includes(settingsPath)
    return { ...lease, async close() { if (instruction) { closeAttempts++; if (!injected) { injected = true; throw originalFault } }; await close() } }
  }, close: () => actualWatch.close() }
  const environment = createInstructionEnvironment({ settingsPath, watch: shared }), bodies: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; bodies.push(body)
    const tool = bodies.length === 1
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'only-real-read', function: { name: 'list_dir', arguments: JSON.stringify({ path: child }) } }] } : { content: 'done' }, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const service = createSessionService({ workspace, coordinator, instructionEnvironment: environment, model: createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: `http://127.0.0.1:${address.port}` }), contextWindow: 100000, codeMode: { mode: 'off' }, approveAll: true })
  try {
    const failed = await service.submit(id, 'actual read before replacement', new AbortController().signal).catch(error => error)
    const tree = (error: unknown): unknown[] => [error, ...(error instanceof AggregateError ? error.errors.flatMap(tree) : []), ...(error instanceof Error && error.cause ? tree(error.cause) : [])]
    expect(failed).toBeInstanceOf(Error); expect(tree(failed)).toContain(originalFault)
    expect(bodies).toHaveLength(1); expect(closeAttempts).toBe(1)
    const original = (await backend.read(id)).events
    expect(original.filter(event => event.type === 'tool/dispatch')).toHaveLength(1)
    expect(original.filter(event => event.type === 'tool/result')).toMatchObject([{ callId: 'only-real-read', envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { entries: ['AGENTS.md'], instruction_scope: { status: 'queued' } } } } }])
    await service.submit(id, 'new genuine human task after original close retry', new AbortController().signal)
    expect(closeAttempts).toBeGreaterThanOrEqual(2); expect(bodies).toHaveLength(2)
    expect(bodies[1]).not.toContain('RETIRED_CHILD_RULE')
    const final = (await backend.read(id)).events
    expect(final.filter(event => event.type === 'tool/dispatch')).toHaveLength(1)
    expect(final.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(final.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(2)
  } finally { injected = true; await service.close(); await environment.close(); await coordinator.close(); await shared.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmWorkspaceSync(root) }
})
