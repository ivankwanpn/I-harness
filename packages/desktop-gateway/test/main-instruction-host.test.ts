import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'

it('actual Desktop main uses its exact native profile and propagates saved policy to physical requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-desktop-instructions-')), workspace = join(root, 'workspace'), profile = join(root, 'native')
  await mkdir(workspace); await mkdir(profile)
  await writeFile(join(root, 'AGENTS.md'), 'ANCESTOR_REFERENCE_SENTINEL')
  await writeFile(join(workspace, 'AGENTS.md'), 'DESKTOP_PROJECT_SENTINEL')
  await writeFile(join(profile, 'AGENTS.md'), 'DESKTOP_NATIVE_SENTINEL')
  const bodies: string[] = [], server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; bodies.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const settingsPath = join(profile, 'settings.json'), credentialsPath = join(profile, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: 'read-only', instructions: { enabled: true, maxBytes: 24000 }, compaction: { auto: false },
    llm: { defaultModel: { provider: 'fixture', model: 'fixture' }, providers: { fixture: { protocol: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}`, apiKeyEnv: 'OWNED_LOCAL_KEY', models: [{ id: 'fixture', contextWindow: 100000, maxTokens: 1024 }] } } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { OWNED_LOCAL_KEY: 'owned-loopback-only' } }))
  const frames: RpcMessage[] = [], host = await createDesktopHost({ workspace, sessionDir: join(root, 'sessions'), settingsPath, credentialsPath, onWrite: frame => frames.push(frame) })
  let id = 0
  const call = async (method: string, params: unknown = {}) => {
    const current = ++id; await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }))
    const result = frames.find(frame => 'id' in frame && frame.id === current)
    expect(isRpcSuccess(result), JSON.stringify(result)).toBe(true)
    if (!isRpcSuccess(result)) throw Error('Missing actual host reply')
    return result.result
  }
  try {
    await call('initialize'); const { sessionId } = await call('session/create') as { sessionId: string }
    await call('session/prompt', { sessionId, prompt: 'physical Desktop instruction control' })
    const main = bodies.find(body => body.includes('physical Desktop instruction control'))!
    expect(main.split('DESKTOP_NATIVE_SENTINEL')).toHaveLength(2)
    expect(main.split('DESKTOP_PROJECT_SENTINEL')).toHaveLength(2)
    expect(main).not.toContain('ANCESTOR_REFERENCE_SENTINEL')
  } finally { await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
}, 30000)
