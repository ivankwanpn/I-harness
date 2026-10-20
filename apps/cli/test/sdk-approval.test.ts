import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { HarnessClient } from '@i-harness/sdk'
import type { ChildProcess } from 'node:child_process'
import { sdkApprovesTools } from '../src/sdk-options.ts'

const repo = resolve(import.meta.dirname, '../../..')
const loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href
const expectedNative = 'literal-native\n' + 'N'.repeat(70000)
type Call = { name: string; args: Record<string, unknown> }
async function fixture(options: { yes?: 'before' | 'after'; desktopFullAccess?: boolean; readOnly?: boolean; calls: (root: string) => Call[] }) {
  const root = await mkdtemp(join(process.env.IH_A6_ROOT ?? tmpdir(), 'a-'))
  const workspace = join(root, 'w'), config = join(root, 'c'), store = join(root, 's')
  await mkdir(workspace); await mkdir(config)
  const gate = join(root, 'gate'), effect = join(root, 'effect'), worker = join(workspace, 'worker.mjs')
  await writeFile(worker, `import{appendFileSync,existsSync}from'node:fs';appendFileSync(process.argv[3],'once\\n');process.stdout.write('literal-native\\n'+'N'.repeat(70000));while(!existsSync(process.argv[2]))await new Promise(done=>setTimeout(done,10));process.exitCode=7;`)
  await writeFile(join(workspace, 'small.txt'), 'ordinary read-only literal 中文')
  const calls = options.calls(root), requests: unknown[] = []
  let index = 0
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const bytes of req) raw += bytes
    const body = JSON.parse(raw); requests.push(body)
    const call = calls[index++], id = 'approval-' + index
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const delta = call ? { tool_calls: [{ index: 0, id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'done' }
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const settings = { autoTitle: false, sandboxMode: options.readOnly ? 'read-only' : 'danger-full-access', ...(options.desktopFullAccess ? { approvalMode: 'full-access' } : {}), llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:' + port, apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'fixture-model' }] } }, defaultModel: { provider: 'fixture', model: 'fixture-model' } } }
  await writeFile(join(config, 'settings.json'), JSON.stringify(settings)); await writeFile(join(config, 'credentials.json'), JSON.stringify({ refs: { FIXTURE_API_KEY: 'fixture-key' } }))
  const args = ['--import', loader, join(repo, 'apps/cli/src/index.ts'), 'sdk', ...(options.yes === 'before' ? ['--yes'] : []), '--session-dir', store, ...(options.yes === 'after' ? ['--yes'] : [])]
  const client = HarnessClient.spawn({ command: process.execPath, args, cwd: workspace, env: { IH_CONFIG_DIR: config } })
  const child = Reflect.get(client, 'child') as ChildProcess
  const stderr: Buffer[] = []; child.stderr!.on('data', bytes => stderr.push(Buffer.from(bytes)))
  const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })))
  await client.initialize(); const sessionId = (await client.createSession()).sessionId
  return { root, workspace, store, client, sessionId, gate, effect, requests,
    next(call: Call) { calls[index] = call },
    async close() {
      await writeFile(gate, '')
      await client.close(); const nativeExit = await exited
      await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections() })
      await writeFile(join(root, 'receipt.json'), JSON.stringify({ args, cwd: workspace, settings, requests, nativeExit, stderr: Buffer.concat(stderr).toString(), effectExists: existsSync(effect) }, null, 2))
      expect(await readFile(join(config, 'settings.json'), 'utf8')).toBe(JSON.stringify(settings))
      expect(nativeExit).toEqual({ code: 0, signal: null })
    },
  }
}
const nativeCalls = (root: string): Call[] => [{ name: 'pwsh', args: { command: '& "' + process.execPath + '" "' + join(root, 'w/worker.mjs') + '" "' + join(root, 'gate') + '" "' + join(root, 'effect') + '"; exit $LASTEXITCODE', background: true } }]
const resultOf = (events: any[]) => events.filter(event => event.type === 'tool/result')

it.each(['before', 'after'] as const)('enables the actual original native producer only with SDK --yes (%s directory)', async yes => {
  const f = await fixture({ yes, calls: nativeCalls })
  try {
    await f.client.run({ sessionId: f.sessionId, prompt: 'start original native producer' })
    const event = resultOf((await f.client.history(f.sessionId)).events)[0]
    expect(event.envelope.retention.value.job_id).toMatch(/^bash-/)
    expect(event.envelope.dependencies).toBeUndefined()
    const deadline = Date.now() + 5000
    while (!existsSync(f.effect) && Date.now() < deadline) await new Promise(done => setTimeout(done, 20))
    expect(existsSync(f.effect)).toBe(true); expect(existsSync(f.gate)).toBe(false)
    expect(await readFile(f.effect, 'utf8')).toBe('once\n')
    await writeFile(f.gate, '')
    f.next({ name: 'job_output', args: { job_id: event.envelope.retention.value.job_id, wait: true, timeout_ms: 5000 } })
    await f.client.run({ sessionId: f.sessionId, prompt: 'read the original completed native source' })
    const observed = resultOf((await f.client.history(f.sessionId)).events)[1]
    expect(observed.envelope.retention.value.status).toBe('error')
    const catalogRef = observed.envelope.dependencies.ref
    const catalogPage = await f.client.readResultPage(f.sessionId, { ref: catalogRef })
    if ('kind' in catalogPage || !('data' in catalogPage) || catalogPage.data.kind !== 'text') throw Error('Original native catalog unavailable')
    expect(catalogPage.eof).toBe(true)
    const catalog = JSON.parse(catalogPage.data.text), frame = catalog.entries[0].retention.ref
    expect(frame.completeness).toBe('complete')
    const bytes: Buffer[] = []; let cursor
    for (;;) {
      const page = await f.client.readResultPage(f.sessionId, { ref: frame, viaCatalog: catalogRef, cursor, maxBytes: 4096 })
      if ('kind' in page || !('frames' in page)) throw Error('Original native frame unavailable')
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
      for (const part of page.frames) { expect(part.channel).toBe('stdout'); bytes.push(Buffer.from(part.data, 'base64')) }
      if (page.eof) break
      expect(page.nextCursor).not.toEqual(cursor); cursor = page.nextCursor!
    }
    const body = Buffer.concat(bytes)
    expect(body.toString()).toBe(expectedNative)
    expect(createHash('sha256').update(body).digest('hex')).toBe(createHash('sha256').update(expectedNative).digest('hex'))
    expect(await readFile(f.effect, 'utf8')).toBe('once\n')
  } finally { await f.close() }
}, 20000)

it('recognizes standalone SDK consent without interpreting a consumed directory or -y as consent', () => {
  expect(sdkApprovesTools([])).toBe(false)
  expect(sdkApprovesTools(['--yes', '--session-dir', 'store'])).toBe(true)
  expect(sdkApprovesTools(['--session-dir', 'store', '--yes'])).toBe(true)
  expect(sdkApprovesTools(['--session-dir', '--yes'])).toBe(false)
  expect(sdkApprovesTools(['--session-dir', '--yes', '--session-dir', '--yes'])).toBe(false)
  expect(sdkApprovesTools(['-y'])).toBe(false)
  const result = spawnSync(process.execPath, ['--import', loader, join(repo, 'apps/cli/src/index.ts'), '--help'], { encoding: 'utf8', windowsHide: true })
  expect(result.status).toBe(0); expect(result.stdout).toBe('')
  const help = result.stderr
  expect(help).toContain('sdk [--session-dir DIR] [--yes]')
  expect(help).toContain('explicit per-call sandbox escalation')
  expect(help).toContain('Without --yes, SDK tool approval requests fail closed')
  const invalid = spawnSync(process.execPath, ['--import', loader, join(repo, 'apps/cli/src/index.ts'), 'sdk', '--yes', '--session-dir'], { encoding: 'utf8', windowsHide: true })
  expect(invalid.status).toBe(1)
  expect(invalid.stderr).toContain('--session-dir requires a directory')
  expect(invalid.stdout).toBe('')
})

it.each([false, true])('keeps no-flag SDK approval unanswered even with Desktop full-access=%s', async desktopFullAccess => {
  const f = await fixture({ desktopFullAccess, calls: nativeCalls })
  try {
    await expect(f.client.run({ sessionId: f.sessionId, prompt: 'must refuse native' })).rejects.toThrow('approval required but no answerer registered (fail closed)')
    expect(existsSync(f.effect)).toBe(false)
    expect(resultOf((await f.client.history(f.sessionId)).events)).toEqual([])
  } finally { await f.close() }
}, 20000)

it('keeps an ordinary read-only tool available without process consent', async () => {
  const f = await fixture({ readOnly: true, calls: root => [{ name: 'read', args: { path: join(root, 'w/small.txt') } }] })
  try {
    await f.client.run({ sessionId: f.sessionId, prompt: 'ordinary read-only control' })
    const result = resultOf((await f.client.history(f.sessionId)).events)[0]
    expect(result.envelope.retention.value).toEqual({ content: 'ordinary read-only literal 中文' })
    expect(result.envelope.execution).toEqual({ outcome: 'succeeded', dispatch: 'dispatched' })
    expect(existsSync(f.effect)).toBe(false)
  } finally { await f.close() }
}, 20000)

it('keeps ordinary read-only sandbox writes denied despite SDK consent', async () => {
  const f = await fixture({ yes: 'after', readOnly: true, calls: root => [{ name: 'write', args: { path: join(root, 'w/ordinary.txt'), text: 'must refuse' } }] })
  try {
    await f.client.run({ sessionId: f.sessionId, prompt: 'ordinary write' })
    expect(existsSync(join(f.workspace, 'ordinary.txt'))).toBe(false)
    const events = (await f.client.history(f.sessionId)).events
    expect(resultOf(events)[0].envelope.retention.value).toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(JSON.parse(resultOf(events)[0].envelope.retention.value.error)).toMatchObject({ code: 'SANDBOX_DENIED', mode: 'read-only' })
    expect(events.filter(event => event.type === 'sandbox/mode').map(event => event.mode)).toEqual(['read-only'])
  } finally { await f.close() }
}, 20000)

it('approves one explicit workspace-write escalation and leaves the next ordinary call read-only', async () => {
  const f = await fixture({ yes: 'after', readOnly: true, calls: root => [
    { name: 'write', args: { path: join(root, 'w/first.txt'), text: 'one', sandbox_permissions: 'workspace-write', justification: 'one task-owned fixture file' } },
    { name: 'write', args: { path: join(root, 'w/second.txt'), text: 'must refuse' } },
  ] })
  try {
    await f.client.run({ sessionId: f.sessionId, prompt: 'one transient explicit escalation' })
    expect(await readFile(join(f.workspace, 'first.txt'), 'utf8')).toBe('one')
    expect(existsSync(join(f.workspace, 'second.txt'))).toBe(false)
    const events = (await f.client.history(f.sessionId)).events
    expect(resultOf(events)[0].envelope.retention.value).toMatchObject({ ok: true })
    expect(resultOf(events)[1].envelope.retention.value).toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(JSON.parse(resultOf(events)[1].envelope.retention.value.error)).toMatchObject({ code: 'SANDBOX_DENIED', mode: 'read-only' })
    expect(events.filter(event => event.type === 'sandbox/mode').map(event => event.mode)).toEqual(['read-only'])
  } finally { await f.close() }
}, 20000)

it('refuses explicit escalation without a process approval answerer', async () => {
  const f = await fixture({ readOnly: true, calls: root => [{ name: 'write', args: { path: join(root, 'w/no-consent.txt'), text: 'must refuse', sandbox_permissions: 'workspace-write', justification: 'requires actual consent' } }] })
  try {
    await f.client.run({ sessionId: f.sessionId, prompt: 'no explicit escalation consent' })
    expect(existsSync(join(f.workspace, 'no-consent.txt'))).toBe(false)
    const event = resultOf((await f.client.history(f.sessionId)).events)[0]
    expect(event.envelope.retention.value).toMatchObject({ code: 'SANDBOX_DENIED', denial: { code: 'SANDBOX_DENIED', mode: 'read-only', reason: 'sandbox escalation to "workspace-write" requires approval, but no approval channel is available' } })
  } finally { await f.close() }
}, 20000)
