import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService, createDurableSessionLoader } from '../src/index.ts'

it('cold original completed source is received only after its exact parent lane is published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-d1a-cold-')), config = join(root, 'config'), nonce = randomUUID()
  await mkdir(config)
  const requests: { model: string; messages: unknown }[] = [], delivery = Promise.withResolvers<void>()
  let parentCount = 0, childCount = 0, released = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const data = JSON.parse(body); requests.push(data)
      if (data.model === 'child') childCount++
      const first = data.model === 'parent' && ++parentCount === 1
      const delta = first ? { tool_calls: [{ index: 0, id: 'cold-original-spawn', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'original', agent_type: 'probe', message: 'return original', fork_turns: 'none' }) } }] }
        : { content: data.model === 'child' ? 'original child result' : 'parent completed' }
      if (data.model === 'parent' && JSON.stringify(data.messages).includes('<task_result>')) delivery.resolve()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server address unavailable')
  const endpoint = 'http://127.0.0.1:' + address.port
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/delivery-crash.mts', import.meta.url)), root, endpoint, nonce], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), windowsHide: true, env: { ...process.env, IH_CONFIG_DIR: config }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = '', stderr = '', cut: unknown
  child.stdout!.on('data', value => { stdout += String(value) }); child.stderr!.on('data', value => { stderr += String(value) })
  child.on('message', value => { cut = value })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { released = true; resolve({ code, signal }) }) })
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const output = createContextOutputService({ root: join(root, 'results'), workspaceId: 'd1a-crash', config: { enabled: false } })
  let service: ReturnType<typeof createSessionService> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    const exit = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Original cut not reached\n' + stderr)), 15000) })]); clearTimeout(timer)
    expect(exit).toEqual({ code: 0, signal: null })
    expect(cut).toMatchObject({ nonce, kind: 'before-first-receipt', terminal: { outcome: 'completed' } })
    const before = await backend.read('parent')
    expect(before.events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(0)
    expect(childCount).toBe(1)
    const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'parent', baseUrl: endpoint })
    service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutput: output,
      model, modelPolicy: 'test-mock', codeMode: { mode: 'off' }, sandbox: 'danger-full-access', contextWindow: 100000, approveAll: true })
    const published = await service.assemblyFor('parent')
    await Promise.race([delivery.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cold published source never reached parent request')), 5000) })]); clearTimeout(timer)
    const events = (await backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/admitted' && e.intent === 'user')).toHaveLength(1)
    expect(childCount).toBe(1)
    expect(published.session).toBe((await coordinator.openManagedDocument('parent')).view)
  } finally {
    clearTimeout(timer)
    if (!released) { child.kill(); await exited }
    const cleanup: unknown[] = []
    for (const close of [() => service?.close(), () => coordinator.close(), () => output.close()]) try { await close() } catch (e) { cleanup.push(String(e)) }
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (process.env.IH_DELIVERY_EVIDENCE_ROOT) {
      await mkdir(process.env.IH_DELIVERY_EVIDENCE_ROOT, { recursive: true })
      await writeFile(join(process.env.IH_DELIVERY_EVIDENCE_ROOT, 'cold-publication.json'), JSON.stringify({ root, nonce, cut, cutFile: await readFile(join(root, 'cut.json'), 'utf8').catch(() => undefined), stdout, stderr, cleanup, exit: await exited, requests, childCount, parentCount }, null, 2))
    }
    expect(cleanup).toEqual([])
  }
}, 25000)
