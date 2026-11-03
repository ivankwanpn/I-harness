import { afterEach, expect, it, vi } from 'vitest'
const gate = vi.hoisted(() => ({ path: '', entered: undefined as (() => void) | undefined, release: undefined as Promise<void> | undefined }))
vi.mock('node:fs/promises', async original => {
  const native = await original<typeof import('node:fs/promises')>()
  return { ...native, readFile: async (...args: Parameters<typeof native.readFile>) => {
    if (String(args[0]).toLowerCase() === gate.path.toLowerCase() && gate.release) { gate.entered?.(); await gate.release }
    return native.readFile(...args)
  } }
})
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fromJSONL } from '@i-harness/core-session'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'

afterEach(() => { gate.path = ''; gate.release = undefined; gate.entered = undefined; vi.unstubAllGlobals() })
it('cold configured Gateway manual compaction opens its command action before resolver I/O and observes actual Stop through the host fence', async () => {
  let calls = 0
  vi.stubGlobal('fetch', async () => { calls++; throw new Error('Unexpected network destination') })
  const root = await mkdtemp(join(tmpdir(), 'ih-manual-gateway-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: 'read-only', webSearchMode: 'disabled', llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'https://manual-host.fixture.invalid', apiKeyEnv: 'IH_MANUAL_FIXTURE_KEY', models: [{ id: 'fixture', contextWindow: 100000, maxTokens: 10000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_MANUAL_FIXTURE_KEY: 'fixture-only' } }))
  const frames: RpcMessage[] = [], host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: frame => frames.push(frame) })
  let next = 0
  const rpc = async (method: string, params: unknown) => {
    const id = ++next
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return frames.find(frame => 'id' in frame && frame.id === id)
  }
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  let manual: Promise<RpcMessage | undefined> | undefined
  try {
    expect(isRpcSuccess(await rpc('initialize', {}))).toBe(true)
    const created = await rpc('session/create', {})
    if (!isRpcSuccess(created)) throw new Error('Fixture session creation failed')
    const { sessionId } = created.result as { sessionId: string }
    gate.path = credentialsPath; gate.entered = entered.resolve; gate.release = released.promise
    manual = rpc('desktop/session/compact', { sessionId })
    const reachedResolver = await Promise.race([entered.promise.then(() => true), manual.then(() => false)])
    expect(reachedResolver).toBe(true)
    const events = fromJSONL(await readFile(join(sessionDir, `${sessionId}.jsonl`), 'utf8')).events
    expect(events.filter(event => event.type === 'command/run' && event.name === 'compact')).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'open').map(event => event.purpose)).toEqual(['manual'])
    expect(events.filter(event => event.type === 'context/action' && event.op === 'bind')).toHaveLength(0)
    expect(calls).toBe(0)
    const stopped = await rpc('session/cancel', { sessionId })
    expect(isRpcSuccess(stopped)).toBe(true)
    released.resolve()
    expect(isRpcSuccess(await manual)).toBe(false)
    expect(calls).toBe(0)
    const cold = fromJSONL(await readFile(join(sessionDir, `${sessionId}.jsonl`), 'utf8')).events
    expect(cold.filter(event => event.type === 'context/attempt' || event.type === 'step/start' || event.type === 'model/exchange-accepted')).toHaveLength(0)
  } finally { released.resolve(); await manual?.catch(() => {}); await host.close() }
})

it.each(['session/prompt', 'desktop/session/input/submit'] as const)('configured Gateway %s observes Stop while the actual credential resolver and nested management fence are held', async method => {
  let calls = 0
  vi.stubGlobal('fetch', async () => { calls++; throw new Error('Unexpected network destination') })
  const root = await mkdtemp(join(tmpdir(), 'ih-main-gateway-stop-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: 'read-only', webSearchMode: 'disabled', llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'https://main-host.fixture.invalid', apiKeyEnv: 'IH_MAIN_FIXTURE_KEY', models: [{ id: 'fixture', contextWindow: 100000, maxTokens: 10000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_MAIN_FIXTURE_KEY: 'fixture-only' } }))
  const frames: RpcMessage[] = [], finished = Promise.withResolvers<void>()
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: frame => { frames.push(frame); if ('method' in frame && frame.method === 'session/status' && ['failed', 'completed'].includes(String((frame.params as { status?: string }).status))) finished.resolve() } })
  let next = 0
  const rpc = async (operation: string, params: unknown) => { const id = ++next; await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method: operation, params })); return frames.find(frame => 'id' in frame && frame.id === id) }
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  let running: Promise<RpcMessage | undefined> | undefined
  try {
    expect(isRpcSuccess(await rpc('initialize', {}))).toBe(true)
    const created = await rpc('session/create', {})
    if (!isRpcSuccess(created)) throw new Error('Fixture session creation failed')
    const { sessionId } = created.result as { sessionId: string }
    gate.path = credentialsPath; gate.entered = entered.resolve; gate.release = released.promise
    running = rpc(method, method === 'session/prompt' ? { sessionId, prompt: 'exact raw human request' } : { sessionId, text: 'exact raw human request', delivery: 'queue', clientToken: 'main-stop-fixture-token' })
    await entered.promise
    const events = fromJSONL(await readFile(join(sessionDir, `${sessionId}.jsonl`), 'utf8')).events
    expect(events.filter(event => event.type === 'agent/input/admitted')).toEqual([expect.objectContaining({ text: 'exact raw human request' })])
    expect(events.filter(event => event.type === 'context/action' && event.op === 'open').map(event => event.purpose)).toEqual(['main'])
    expect(events.filter(event => event.type === 'context/action' && event.op === 'bind')).toHaveLength(0)
    expect(isRpcSuccess(await rpc('session/cancel', { sessionId }))).toBe(true)
    expect(calls).toBe(0); released.resolve(); await running
    if (method === 'desktop/session/input/submit') await finished.promise
    const cold = fromJSONL(await readFile(join(sessionDir, `${sessionId}.jsonl`), 'utf8')).events
    expect(cold.filter(event => event.type === 'context/attempt' || event.type === 'agent/input/promoted' || event.type === 'model/exchange-accepted')).toHaveLength(0)
    expect(calls).toBe(0)
  } finally { released.resolve(); await running?.catch(() => {}); await host.close() }
})
