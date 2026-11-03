import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService } from '../src/index.ts'

afterEach(() => vi.unstubAllGlobals())
it.each(['before-reservation', 'reservation-before-handoff', 'handoff-before-response', 'output-before-acceptance', 'settled-tool'] as const)('a real process crash at %s cannot reconstruct a consumed origin or replay its tool effect', async cut => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-crash-')), id = 'crash-owner'
  let calls = 0, crashed = false, reached = false, output = '', errors = ''
  let child: ReturnType<typeof spawn> | undefined
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(400).end(); return }
    request.resume(); request.on('end', () => {
      calls++
      if (!crashed && cut === 'handoff-before-response') { reached = true; child!.kill('SIGKILL'); return }
      const delta = !crashed && (cut === 'settled-tool' || cut === 'output-before-acceptance') ? { tool_calls: [{ index: 0, id: 'original-effect', type: 'function', function: { name: 'crash_effect', arguments: '{}' } }] } : { content: 'new input remains usable' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing controlled endpoint')
  const endpoint = 'http://127.0.0.1:' + address.port
  const nativeFetch = globalThis.fetch
  vi.stubGlobal('fetch', (async (url: string, init?: RequestInit) => { if (url !== endpoint + '/v1/chat/completions') throw new Error('Unexpected network destination'); return nativeFetch(url, init) }) as typeof globalThis.fetch)
  child = spawn(process.execPath, [fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('./helpers/crash-generation.mts', import.meta.url)), root, id, endpoint, cut], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('AT_CUT')) reached = true })
  child.stderr!.on('data', chunk => { errors += String(chunk) })
  const exited = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('exit', () => resolve()) })
  let coordinator: ReturnType<typeof createSessionCoordinator> | undefined, service: ReturnType<typeof createSessionService> | undefined
  try {
    await exited
    expect(reached, output + errors).toBe(true); crashed = true
    const initialCalls = cut === 'before-reservation' || cut === 'reservation-before-handoff' ? 0 : 1
    expect(calls).toBe(initialCalls)
    const backend = createJsonlBackend(root), before = (await backend.read(id)).events
    expect(before.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(cut === 'before-reservation' ? 0 : 1)
    expect(before.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(cut === 'settled-tool' ? 1 : 0)
    expect(existsSync(join(root, 'effect.txt'))).toBe(cut === 'settled-tool')
    coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
    const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: endpoint })
    service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' } })
    const original = before.find(event => event.type === 'agent/input/admitted')!
    if (original.type !== 'agent/input/admitted') throw new Error('Missing real admission')
    await expect(service.submit(id, original.text, new AbortController().signal, { admittedInputId: original.inputId })).rejects.toThrow()
    expect(calls).toBe(initialCalls)
    expect((await backend.read(id)).events.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(1)
    await service.submit(id, 'new explicit human input after the crash', new AbortController().signal)
    expect(calls).toBe(initialCalls + 1)
    const after = (await backend.read(id)).events
    expect(after.filter(event => event.type === 'tool/dispatch')).toHaveLength(cut === 'settled-tool' ? 1 : 0)
    if (cut === 'settled-tool') expect(await readFile(join(root, 'effect.txt'), 'utf8')).toBe('exactly once')
  } finally { child.kill('SIGKILL'); await exited.catch(() => {}); await service?.close().catch(() => {}); await coordinator?.close().catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}, 30_000)
