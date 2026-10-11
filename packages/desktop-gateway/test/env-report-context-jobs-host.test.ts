import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'
import { createHostFixtureTrace } from './host-fixture-trace.ts'

it('registers Desktop code index job IDs in the actual session job tools', async () => {
  const trace = createHostFixtureTrace('env-report-context-jobs-host')
  const observations = new Map<string, any>()
  let step = 0, jobId = ''
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    for (const message of body.messages ?? []) if (message.role === 'tool') {
      const content = typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text ?? '').join('')
      const output = JSON.parse(content)
      observations.set(message.tool_call_id, output)
      if (message.tool_call_id === 'index') jobId = output.jobId
    }
    const calls = [
      { id: 'index', name: 'code_context_index', args: {} },
      { id: 'list', name: 'job_list', args: {} },
      { id: 'kill', name: 'job_kill', args: { job_id: jobId } },
      { id: 'output', name: 'job_output', args: { job_id: jobId } },
    ]
    const call = calls[step++]
    const delta = call ? { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'Fixture completed.' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const base = resolve('build/env-report-context-jobs-host'); await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'fixture-')), workspace = join(root, 'repo'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(join(workspace, 'main.ts'), 'export const indexedneedle = true\n')
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: 'danger-full-access', approvalMode: 'full-access', llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: `${origin}/v1`, models: [{ id: 'fixture', contextWindow: 272000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  const originalFetch = globalThis.fetch
  const fetchGuard = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== origin) throw new Error('Fixture refused a non-loopback provider request')
    return originalFetch(input, init)
  })
  const frames: RpcMessage[] = []
  const host = await trace.run('host/create', () => createDesktopHost({ workspace, sessionDir: join(root, 'sessions'), settingsPath, onWrite: frame => { trace.observe(frame); frames.push(frame) } }))
  let id = 0
  const call = async (method: string, params = {}) => {
    const requestId = ++id; await trace.run(method, () => host.handleLine(encodeFrame(makeRequest(requestId, method, params))))
    const reply = frames.find(frame => 'id' in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result as any
  }
  try {
    await call('initialize')
    await call('desktop/provider/mutate', { action: 'key/set', id: 'fixture', value: 'test-only-key' })
    await call('desktop/context-subsystems/configure', { patch: { scope: 'workspace', codeRetrieval: { enabled: true } } })
    const { sessionId } = await call('session/create')
    await call('session/prompt', { sessionId, prompt: 'Exercise code indexing and job controls.' })
    expect(jobId).toMatch(/^code-context-/)
    expect(observations.get('list')?.jobs).toContainEqual(expect.objectContaining({ id: jobId, kind: 'code-context' }))
    expect(observations.get('kill')).toMatchObject({ outcome: expect.stringMatching(/^(already-finished|cancellation-requested)$/) })
    expect(observations.get('output')).toMatchObject({ status: expect.stringMatching(/^(completed|killed)$/) })
    const state = await call('desktop/context-subsystems/state')
    expect(state.code.lastJob).toMatchObject({ jobId, outcome: expect.stringMatching(/^(completed|cancelled)$/) })
  } finally {
    await trace.run('host/close', () => host.close()); fetchGuard.mockRestore()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
