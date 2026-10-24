import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService } from '../src/index.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { rmWorkspaceSync } from './helpers.ts'

const answer = (calls: { id: string; path: string }[]) => `data: ${JSON.stringify({ choices: [{ delta: calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, function: { name: 'list_dir', arguments: JSON.stringify({ path: call.path }) } })) } : { content: 'done' }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`
async function fixture(count: number, response: (ordinal: number, directories: string[]) => string, durable = false) {
  const root = await mkdtemp(join(tmpdir(), 'ih-targets-')), workspace = join(root, 'workspace')
  await mkdir(workspace); await writeFile(join(workspace, 'AGENTS.md'), 'REQUIRED_CWD_SENTINEL')
  const directories: string[] = []
  for (let index = 0; index < count; index++) { const path = join(workspace, `d${index}`); await mkdir(path); await writeFile(join(path, 'AGENTS.md'), `DIRECTORY_${index}_SENTINEL`); directories.push(path) }
  const bodies: string[] = []
  const server = createServer(async (request, output) => {
    let body = ''; for await (const chunk of request) body += chunk
    bodies.push(body); output.writeHead(200, { 'content-type': 'text/event-stream' }); output.end(response(bodies.length - 1, directories))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback listener')
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const environment = createProjectInstructionEnvironment(), create = environment.host.create.bind(environment.host)
  let opened = 0, closed = 0, live = 0, peak = 0
  const prepared: { targets: readonly { path: string; kind: string }[]; complete: boolean; reliability: string; candidates: number }[] = []
  environment.host.create = scope => {
    const source = create(scope); opened++; live++; peak = Math.max(peak, live); let completed = false
    return { ...source, async prepare(targets) { const snapshot = await source.prepare(targets); prepared.push({ targets, complete: snapshot.complete, reliability: snapshot.reliability, candidates: snapshot.candidates.length }); return snapshot }, async close() { await source.close(); if (!completed) { completed = true; closed++; live-- } } }
  }
  const lifetime = () => ({ opened, closed, live, peak })
  const service = createSessionService({ workspace, instructionEnvironment: environment, ...(durable ? { coordinator } : {}), model: createOpenAICompatibleClient({ apiKey: 'owned-loopback', model: 'fixture', baseUrl: `http://127.0.0.1:${address.port}` }), contextWindow: 1000000, maxOutputTokens: 1024, codeMode: { mode: 'off' }, approveAll: true })
  return { root, workspace, directories, bodies, backend, service, id, prepared, lifetime, async close() {
    const evidence = process.env.IH_INSTRUCTION_EVIDENCE_ROOT
    const events = service.liveSession(id)?.events, beforeClose = lifetime()
    await service.close(); await environment.close(); await coordinator.close()
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, `targets-${count}.json`), JSON.stringify({ durable, directories, beforeClose, afterClose: lifetime(), prepared, requests: bodies.map((body, ordinal) => ({ ordinal, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body), current: (JSON.parse(body).messages as { role: string; content: unknown }[]).find(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('REQUIRED_CWD_SENTINEL'))?.content })), samples: [bodies[0], bodies[Math.floor(bodies.length / 2)], bodies.at(-1)], events }, null, 2))
    }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmWorkspaceSync(root)
  } }
}

it.each([3, 257])('%i actual registered directory reads select fresh exact views with required ancestry and revisit reload', async count => {
  const f = await fixture(count, (ordinal, paths) => answer(ordinal < paths.length ? [{ id: `read-${ordinal}`, path: paths[ordinal]! }] : []))
  try {
    await f.service.submit(f.id, 'visit sequential directories', AbortSignal.timeout(540000))
    expect(f.bodies).toHaveLength(count + 1)
    for (let index = 1; index < f.bodies.length; index++) {
      const body = f.bodies[index]!
      expect(body.split('REQUIRED_CWD_SENTINEL')).toHaveLength(2)
      expect(body.match(/DIRECTORY_\d+_SENTINEL/g)).toEqual([`DIRECTORY_${index - 1}_SENTINEL`])
    }
    const results = f.service.liveSession(f.id)!.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(count)
    for (const event of results) expect(event).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { instruction_scope: { status: 'queued' }, entries: ['AGENTS.md'] } } } })
    expect(f.lifetime()).toEqual({ opened: count + 1, closed: count, live: 1, peak: 2 })
    expect(f.prepared.every(value => value.complete && value.reliability === 'ready' && value.candidates <= 256)).toBe(true)
    await writeFile(join(f.directories[0]!, 'AGENTS.md'), 'REVISITED_FRESH_SENTINEL')
    const assembly = await f.service.assemblyFor(f.id)
    // Exercise the registered read callback with the exact main Session object.
    const tool = assembly.tools.get('list_dir')!
    await tool.execute({ path: f.directories[0] }, { session: assembly.session, callId: 'revisit' })
    await assembly.agent.followup('unknown continuation retains the observed read wave')
    expect(f.bodies.at(-1)).toContain('REVISITED_FRESH_SENTINEL')
    expect(f.bodies.at(-1)).not.toContain(`DIRECTORY_${count - 1}_SENTINEL`)
    expect(f.lifetime()).toEqual({ opened: count + 2, closed: count + 1, live: 1, peak: 2 })
  } finally { await f.close() }
}, 600000)

it('a single over-cap read wave blocks honestly and a genuinely promoted small human task recovers', async () => {
  const f = await fixture(130, (ordinal, paths) => answer(ordinal === 0 ? paths.map((path, index) => ({ id: `wide-${index}`, path })) : []), true)
  try {
    await expect(f.service.submit(f.id, 'read one oversized wave', AbortSignal.timeout(90000))).rejects.toThrow()
    expect(f.bodies).toHaveLength(1)
    expect((await f.backend.read(f.id)).events.filter(event => event.type === 'tool/result')).toHaveLength(130)
    await f.service.submit(f.id, 'new small genuine task', new AbortController().signal)
    expect(f.bodies).toHaveLength(2)
    expect(f.bodies[1]).toContain('REQUIRED_CWD_SENTINEL')
    expect(f.bodies[1]).not.toMatch(/DIRECTORY_\d+_SENTINEL/)
  } finally { await f.close() }
}, 120000)
