import { expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { runHeadless } from '../src/run.ts'
import { createOpenAICompatibleClient } from '../../../packages/llm-openai-compatible/src/index.ts'

const repo = resolve(import.meta.dirname, '../../..'), loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href, entry = join(repo, 'apps/cli/src/index.ts')

function driver(child: ChildProcessWithoutNullStreams) {
  let buffer = '', ordinal = 0
  const responses = new Map<number, { resolve(value: any): void; reject(error: unknown): void }>()
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code)) })
  let diagnostics = ''
  child.stderr.on('data', chunk => { diagnostics += chunk })
  child.stdout.on('data', chunk => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try { const value = JSON.parse(line), pending = responses.get(value.id); if (pending) { responses.delete(value.id); value.error ? pending.reject(Error(JSON.stringify(value.error))) : pending.resolve(value.result) } } catch { /* Non-RPC run output is collected by its exit contract. */ }
    }
  })
  return { exit, diagnostics: () => diagnostics, request(method: string, params: unknown = {}) {
    const id = ++ordinal
    const pending = new Promise<any>((resolve, reject) => responses.set(id, { resolve, reject }))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return Promise.race([pending, exit.then(code => { throw Error(`CLI exited ${code}: ${diagnostics}`) })])
  } }
}

it.each(['run', 'sdk', 'acp', 'explicit-headless'] as const)('actual %s entry sends selected native instructions exactly once', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-entry-instructions-')), workspace = join(root, 'workspace'), profile = join(root, 'native'), ambient = join(root, 'ambient')
  await mkdir(workspace); await mkdir(profile); await mkdir(ambient)
  await writeFile(join(workspace, 'AGENTS.md'), 'ENTRY_PROJECT_SENTINEL')
  await writeFile(join(profile, 'AGENTS.md'), 'ENTRY_NATIVE_SENTINEL')
  await writeFile(join(ambient, 'AGENTS.md'), 'ENTRY_AMBIENT_SENTINEL')
  await writeFile(join(root, 'AGENTS.md'), 'ENTRY_ANCESTOR_SENTINEL')
  const bodies: string[] = [], server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; bodies.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const baseUrl = `http://127.0.0.1:${address.port}`, settingsPath = join(profile, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: 'read-only', instructions: { enabled: true, maxBytes: 24000 }, codeMode: { mode: 'off' }, compaction: { auto: false },
    llm: { defaultModel: { provider: 'fixture', model: 'fixture' }, providers: { fixture: { protocol: 'openai-completions', baseURL: baseUrl, apiKeyEnv: 'OWNED_LOCAL_KEY', models: [{ id: 'fixture', contextWindow: 100000, maxTokens: 1024 }] } } } }))
  await writeFile(join(profile, 'credentials.json'), JSON.stringify({ refs: { OWNED_LOCAL_KEY: 'owned-loopback-only' } }))
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    if (mode === 'explicit-headless') {
      const result = await runHeadless('physical explicit headless control', { workspace, instructionSettingsPath: settingsPath, model: createOpenAICompatibleClient({ apiKey: 'owned-loopback-only', model: 'fixture', baseUrl }), codeMode: { mode: 'off' } })
      expect(result.exitCode, result.error).toBe(0)
    } else {
      child = spawn(process.execPath, ['--import', loader, entry, mode, ...(mode === 'run' ? ['physical CLI instruction control'] : []), '--session-dir', join(root, 'sessions')], {
        cwd: workspace, env: { ...process.env, IH_CONFIG_DIR: profile, HOME: ambient, USERPROFILE: ambient }, stdio: 'pipe', windowsHide: true,
      })
      const io = driver(child)
      if (mode === 'sdk') {
        await io.request('initialize'); const { sessionId } = await io.request('session/create')
        await io.request('session/prompt', { sessionId, prompt: 'physical SDK instruction control' })
        await io.request('shutdown'); child.stdin.end()
      } else if (mode === 'acp') {
        await io.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'owned-instruction-fixture', version: '1' } })
        const { sessionId } = await io.request('session/new', { cwd: workspace, mcpServers: [] })
        await io.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'physical ACP instruction control' }] })
        child.stdin.end()
      } else child.stdin.end()
      expect(await io.exit, io.diagnostics()).toBe(0)
    }
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies[0]!.split('ENTRY_NATIVE_SENTINEL')).toHaveLength(2)
    expect(bodies[0]!.split('ENTRY_PROJECT_SENTINEL')).toHaveLength(2)
    expect(bodies[0]).not.toContain('ENTRY_AMBIENT_SENTINEL')
    expect(bodies[0]).not.toContain('ENTRY_ANCESTOR_SENTINEL')
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise<void>(resolve => child!.once('exit', () => resolve())) }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true })
  }
}, 45000)
