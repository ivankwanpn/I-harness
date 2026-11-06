import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { main } from '../src/index.ts'

const previousConfigDir = process.env.IH_CONFIG_DIR
const previousStore = process.env.IH_SESSION_STORE
let server: ReturnType<typeof createServer>
let configDir: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'fixture answer' } }] }), 'data: [DONE]', ''].join('\n\n'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = typeof address === 'object' && address ? 'http://127.0.0.1:' + address.port : 'http://127.0.0.1:1'
  configDir = mkdtempSync(join(tmpdir(), 'ih-cli-scl-run-config-'))
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
    sandboxMode: 'read-only',
    compaction: { auto: false },
    llm: {
      providers: { fixture: { protocol: 'openai-completions', baseURL: origin, apiKeyEnv: 'IH_CLI_SCL_KEY', models: [{ id: 'fixture' }] } },
      defaultModel: { provider: 'fixture', model: 'fixture' },
    },
  }))
  writeFileSync(join(configDir, 'credentials.json'), JSON.stringify({ refs: { IH_CLI_SCL_KEY: 'key' } }))
  process.env.IH_CONFIG_DIR = configDir
  process.env.IH_SESSION_STORE = 'commit-log'
})
afterAll(async () => {
  await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
  if (previousConfigDir === undefined) delete process.env.IH_CONFIG_DIR
  else process.env.IH_CONFIG_DIR = previousConfigDir
  if (previousStore === undefined) delete process.env.IH_SESSION_STORE
  else process.env.IH_SESSION_STORE = previousStore
})

it('runs a headless session on the commit-log store', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'ih-cli-scl-run-'))
  expect(await main(['node', 'i-harness', 'run', 'hello', '--session-dir', storeDir])).toBe(0)
  const generations = readdirSync(storeDir).filter(entry => entry !== '__documents__' && existsSync(join(storeDir, entry, 'session.v15.jsonl')))
  expect(generations.length).toBe(1)
}, 60000)
it('runs on the store selected by --session-store, without the environment variable', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'ih-cli-flag-scl-'))
  const before = process.env.IH_SESSION_STORE
  delete process.env.IH_SESSION_STORE
  try {
    expect(await main(['node', 'i-harness', 'run', 'hello', '--session-dir', storeDir, '--session-store', 'commit-log'])).toBe(0)
    const generations = readdirSync(storeDir).filter(entry => entry !== '__documents__' && existsSync(join(storeDir, entry, 'session.v15.jsonl')))
    expect(generations.length).toBe(1)
  } finally {
    if (before === undefined) delete process.env.IH_SESSION_STORE
    else process.env.IH_SESSION_STORE = before
  }
}, 60000)

it('lets --session-store jsonl override the environment', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'ih-cli-flag-legacy-'))
  const before = process.env.IH_SESSION_STORE
  delete process.env.IH_SESSION_STORE
  try {
    expect(await main(['node', 'i-harness', 'run', 'hello', '--session-dir', storeDir, '--session-store', 'jsonl'])).toBe(0)
    // The legacy store writes the session file plus its task document.
    const legacy = readdirSync(storeDir).filter(entry => entry.endsWith('.jsonl') && !entry.endsWith('.doc.jsonl'))
    expect(legacy.length).toBe(1)
    const generations = readdirSync(storeDir).filter(entry => entry !== '__documents__' && existsSync(join(storeDir, entry, 'session.v15.jsonl')))
    expect(generations.length).toBe(0)
  } finally {
    if (before === undefined) delete process.env.IH_SESSION_STORE
    else process.env.IH_SESSION_STORE = before
  }
}, 60000)