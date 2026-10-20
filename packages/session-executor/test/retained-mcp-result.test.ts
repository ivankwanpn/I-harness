import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgent } from '@i-harness/core-agent'
import { deriveMessages, type ManagedArtifactRef } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { createMcpTool, type ConnectedMcpClient } from '@i-harness/mcp-client'
import { createToolResultRetention } from '../src/lifecycle/result-retention.ts'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { controlledModel } from './controlled-model.ts'
import { PNG, JPEG } from '../../image-validation/test/fixtures.ts'
import { createCodeModeBroker } from '../../code-mode/src/broker.ts'
import { createCodeModeRuntime } from '../../code-mode/src/runtime.ts'

function clientFor(callTool: ConnectedMcpClient['callTool']): ConnectedMcpClient {
  return { callTool, async listTools() { return { tools: [] } }, async listResources() { return [] }, async readResource() { return [] }, async close() {} }
}

function normalized(failed: boolean, images: boolean) {
  return {
    content: [
      { type: 'audio', mimeType: 'audio/wav', data: 'QUJD'.repeat(250_000) },
      { type: 'text', text: 'TEXT_AFTER_BINARY' },
      ...(images ? [{ type: 'image', mimeType: 'image/png', data: PNG }] : []),
      { type: 'resource', resource: { uri: 'file:///fixture/report.txt', mimeType: 'text/plain', text: 'RESOURCE_TEXT' } },
      ...(images ? [{ type: 'image', mimeType: 'image/jpeg', data: JPEG }] : []),
      { type: 'resource_link', uri: 'https://example.invalid/fixture', name: 'RESOURCE_LINK' },
    ],
    isError: failed,
    structuredContent: { body: 'x'.repeat(1_048_576), sentinel: 'BEYOND_PREVIEW', error: 'payload data', code: 'payload data', isError: !failed, images: ['ordinary structured field'], ref: { id: 'not-authority' } },
  }
}

async function fixture(quota = false) {
  const base = resolve(import.meta.dirname, '../../../build/r4a-mcp-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'managed-'))
  const backend = createJsonlBackend(resolve(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture', config: { enabled: false, ...(quota ? { maxDiskBytes: 1 } : {}) } })
  const ctx = createContext(), tools = createToolRegistry(ctx, { resultRetention: createToolResultRetention(service, undefined, id) })
  return { root, id, document, backend, coordinator, service, ctx, tools, async close() { await coordinator.close(); await service.close(); await rm(root, { recursive: true, force: true }) } }
}

async function coldRead(f: Awaited<ReturnType<typeof fixture>>, ref: ManagedArtifactRef) {
  await f.service.close()
  const cold = createContextOutputService({ root: resolve(f.root, 'context'), workspaceId: 'fixture' })
  const chunks: Buffer[] = []
  try {
    let offset = 0
    for (;;) {
      const page = await cold.readResult({ sessionId: f.id }, { ref, offset })
      expect(page.ref.codec).toBe('json-utf8-v1')
      expect(page.offset).toBe(offset)
      const bytes = page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64')
      chunks.push(bytes); offset += bytes.length
      if (page.eof) break
      expect(page.nextOffset).toBe(offset)
    }
    const bytes = Buffer.concat(chunks)
    expect(bytes.length).toBe(ref.encodedBytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.contentDigest)
    return bytes
  } finally { await cold.close() }
}

it.each([true, false])('describes genuine managed MCP blocks beyond leading binary (supported images=%s)', async images => {
  const f = await fixture()
  let calls = 0, hooks = 0, sends = 0
  const client = clientFor(async () => { calls++; return normalized(false, images) })
  f.tools.register(createMcpTool(client, 'remote', 'raw', { name: 'raw' }, { transport: 'stdio', serverName: 'fixture', command: 'unused', args: [] }))
  f.ctx.on('tools/post-execute', () => { hooks++ })
  const agent = createAgent(f.ctx, { generationFactory: action => createGenerationLifecycle(f.document.view, f.id, action), session: f.document.view, factOwner: f.document,
    tools: f.tools, sessionId: f.id, systemPrompt: '', model: controlledModel(async function* () {
      if (++sends === 1) yield { type: 'tool_call', call: { id: 'actual', name: 'remote', args: {} } }
      else yield { type: 'text/chunk', text: 'complete' }
      yield { type: 'end' }
    }) })
  try {
    await agent.run('inspect MCP')
    const result = f.document.view.events.find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result' || result.envelope?.retention.kind !== 'artifact') throw new Error('Expected genuine managed artifact')
    const envelope = result.envelope
    expect(envelope.execution).toEqual({ outcome: 'succeeded', dispatch: 'dispatched' })
    expect(envelope.preview).toContain('TEXT_AFTER_BINARY')
    expect(envelope.preview).toContain('file:///fixture/report.txt')
    expect(envelope.preview).toContain('audio/wav')
    expect(envelope.preview).not.toContain('QUJD'.repeat(100))
    expect(envelope.media.map(image => image.mediaType)).toEqual(images ? ['image/png', 'image/jpeg'] : [])
    expect(Buffer.byteLength(JSON.stringify({ ...envelope, media: [] }))).toBeLessThanOrEqual(64000)
    const toolMessage = deriveMessages(f.document.view).find(message => message.role === 'tool')
    expect(JSON.stringify(toolMessage)).toContain('TEXT_AFTER_BINARY')
    expect(JSON.stringify(toolMessage)).not.toContain('QUJD'.repeat(100))
    const coldEncodedBytes = await coldRead(f, result.envelope.retention.ref)
    expect(coldEncodedBytes.equals(Buffer.from(JSON.stringify(normalized(false, images))))).toBe(true)
    expect(JSON.parse(coldEncodedBytes.toString())).toEqual(normalized(false, images))
    expect({ calls, hooks }).toEqual({ calls: 1, hooks: 1 })
  } finally { await f.close() }
})

it.each([false, true].flatMap(failed => [false, true].map(quota => ({ failed, quota }))))('keeps managed MCP outcome and full program independent of storage ($failed/$quota)', async ({ failed, quota }) => {
  const f = await fixture(quota)
  let calls = 0, hooks = 0
  const client = clientFor(async () => { calls++; return normalized(failed, true) })
  f.tools.register(createMcpTool(client, 'remote', 'raw', { name: 'raw' }, { transport: 'stdio', serverName: 'fixture', command: 'unused', args: [] }))
  f.ctx.on('tools/post-execute', () => { hooks++ })
  const broker = createCodeModeBroker(f.ctx, f.tools, { session: f.document.view, sessionId: f.id, factOwner: f.document })
  broker.startCell('cell')
  try {
    const program = await broker.invoke({ cellId: 'cell', invocationId: 'call', name: 'remote', args: {}, origin: { sessionId: f.id }, signal: new AbortController().signal })
    expect(program).toEqual(normalized(failed, true))
    const result = f.document.view.events.find(event => event.type === 'code/result')
    if (result?.type !== 'code/result' || !result.envelope) throw new Error('Expected original code result')
    expect(result.envelope.execution).toEqual({ outcome: failed ? 'failed' : 'succeeded', dispatch: 'dispatched' })
    expect(result.envelope.preview).toContain('TEXT_AFTER_BINARY')
    expect(result.envelope.preview).toContain('RESOURCE_TEXT')
    expect(result.envelope.preview).toContain('[1] audio')
    expect(result.envelope.preview).not.toContain('QUJD'.repeat(100))
    expect(Buffer.byteLength(JSON.stringify({ ...result.envelope, media: [] }))).toBeLessThanOrEqual(64000)
    if (quota) expect(result.envelope.retention).toMatchObject({ kind: 'unavailable', reason: 'quota' })
    else {
      if (result.envelope.retention.kind !== 'artifact') throw new Error('Expected saved artifact')
      expect((await coldRead(f, result.envelope.retention.ref)).equals(Buffer.from(JSON.stringify(normalized(failed, true))))).toBe(true)
    }
    expect({ calls, hooks }).toEqual({ calls: 1, hooks: 1 })
  } finally { await broker.dispose(); await f.close() }
})

it('transfers full MCP structured data through real WASM and refuses >4MiB while retaining the full host artifact', async () => {
  const f = await fixture()
  let calls = 0, hooks = 0
  const client = clientFor(async (name: string) => {
    calls++
    const result = normalized(false, true)
    if (name === 'large') result.structuredContent.body = 'z'.repeat(4 * 1024 * 1024)
    return result
  })
  for (const name of ['remote', 'large']) f.tools.register(createMcpTool(client, name, name, { name }, { transport: 'stdio', serverName: 'fixture', command: 'unused', args: [] }))
  f.ctx.on('tools/post-execute', () => { hooks++ })
  const broker = createCodeModeBroker(f.ctx, f.tools, { session: f.document.view, sessionId: f.id, factOwner: f.document })
  const runtime = createCodeModeRuntime({ tools: () => broker.definitions(), invoke: call => broker.invoke(call), onEvent(event) { if (event.type === 'started') broker.startCell(event.cellId) } })
  try {
    expect(await runtime.exec({ code: 'const v=await tools.remote({}); text([v.structuredContent.sentinel,v.isError,v.content.map(b=>b.type)]);' }, { sessionId: f.id })).toMatchObject({ status: 'completed', text: '["BEYOND_PREVIEW",false,["audio","text","image","resource","image","resource_link"]]' })
    const capped = await runtime.exec({ code: 'await tools.large({}); text("must not fulfill");' }, { sessionId: f.id })
    expect(capped.status).toBe('failed')
    expect(capped.error).toMatch(/Tool result.*limit|Tool result.*exceed/i)
    expect(capped.text).not.toContain('must not fulfill')
    const results = f.document.view.events.filter(event => event.type === 'code/result')
    expect(results).toHaveLength(2)
    const second = results[1]!
    if (second.type !== 'code/result' || second.envelope?.retention.kind !== 'artifact') throw new Error('Expected host artifact before refused guest transfer')
    const expected = normalized(false, true); expected.structuredContent.body = 'z'.repeat(4 * 1024 * 1024)
    expect((await coldRead(f, second.envelope.retention.ref)).equals(Buffer.from(JSON.stringify(expected)))).toBe(true)
    expect({ calls, hooks }).toEqual({ calls: 2, hooks: 2 })
  } finally { await runtime.dispose(); await broker.dispose(); await f.close() }
})

it('settles the same original managed MCP finish-unknown operation without replaying callbacks or hooks', async () => {
  const f = await fixture()
  let blocked = true, calls = 0, hooks = 0, getters = 0, sends = 0, finishes = 0
  const scopes = new Set<object>(), begin = f.service.beginResult.bind(f.service)
  vi.spyOn(f.service, 'beginResult').mockImplementation(async (scope, codec) => {
    scopes.add(scope)
    const sink = await begin(scope, codec), finish = sink.finish.bind(sink)
    sink.finish = async completeness => {
      finishes++
      const settled = await finish(completeness)
      return blocked ? { kind: 'recovery-required', operationId: scope.operationId } : settled
    }
    return sink
  })
  const client = clientFor(async () => {
    calls++
    const result = normalized(false, true)
    return { content: result.content, isError: result.isError, get structuredContent() { getters++; return result.structuredContent } }
  })
  f.tools.register(createMcpTool(client, 'remote', 'raw', { name: 'raw' }, { transport: 'stdio', serverName: 'fixture', command: 'unused', args: [] }))
  f.ctx.on('tools/post-execute', () => { hooks++ })
  const agent = createAgent(f.ctx, { generationFactory: action => createGenerationLifecycle(f.document.view, f.id, action), session: f.document.view, factOwner: f.document, tools: f.tools, sessionId: f.id, systemPrompt: '', model: controlledModel(async function* () {
    sends++; yield { type: 'tool_call', call: { id: 'original', name: 'remote', args: {} } }; yield { type: 'end' }
  }) })
  try {
    await expect(agent.run('inspect original')).rejects.toBeDefined()
    expect(f.document.view.events.filter(event => event.type === 'tool/result')).toHaveLength(0)
    expect(() => f.document.assertReady()).toThrow()
    expect({ calls, hooks, getters, sends }).toEqual({ calls: 1, hooks: 1, getters: 1, sends: 1 })
    blocked = false
    // drain() flushes only admitted facts. The original document close owns
    // retrying its registered settlement sources after finish uncertainty.
    await f.document.close()
    const results = f.document.view.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    const result = results[0]!
    if (result.type !== 'tool/result' || result.envelope?.retention.kind !== 'artifact') throw new Error('Expected original settled artifact fact')
    expect((await coldRead(f, result.envelope.retention.ref)).equals(Buffer.from(JSON.stringify(normalized(false, true))))).toBe(true)
    expect({ calls, hooks, getters, sends, scopes: scopes.size }).toEqual({ calls: 1, hooks: 1, getters: 1, sends: 1, scopes: 1 })
    expect(finishes).toBeGreaterThan(1)
    expect((await f.backend.read(f.id)).events.filter(event => event.type === 'tool/result')).toHaveLength(1)
  } finally { blocked = false; vi.restoreAllMocks(); await f.close() }
})

it('keeps a genuine ordinary lookalike inline with successful outcome despite similarly named payload fields', async () => {
  const f = await fixture()
  const value = { content: [{ type: 'audio', mimeType: 'audio/wav', data: 'QUJD' }], structuredContent: null, isError: true, error: 'payload', ref: { id: 'not-authority' } }
  f.tools.register({ name: 'ordinary', description: '', inputSchema: {}, async execute() { return value } })
  const broker = createCodeModeBroker(f.ctx, f.tools, { session: f.document.view, sessionId: f.id, factOwner: f.document })
  broker.startCell('cell')
  try {
    expect(await broker.invoke({ cellId: 'cell', invocationId: 'call', name: 'ordinary', args: {}, origin: { sessionId: f.id }, signal: new AbortController().signal })).toEqual(value)
    expect(f.document.view.events.find(event => event.type === 'code/result')).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value } } })
  } finally { await broker.dispose(); await f.close() }
})

it('uses generic capture for a trusted post-execute transform that replaces normalized content', async () => {
  const f = await fixture()
  f.tools.register(createMcpTool(clientFor(async () => normalized(false, true)), 'remote', 'raw', { name: 'raw' }, { transport: 'stdio', serverName: 'fixture', command: 'unused', args: [] }))
  const transformed = { transformed: true, structuredContent: null }
  f.ctx.onCascade('tools/execute', async (_input, next) => { await next(); return transformed })
  const broker = createCodeModeBroker(f.ctx, f.tools, { session: f.document.view, sessionId: f.id, factOwner: f.document })
  broker.startCell('cell')
  try {
    expect(await broker.invoke({ cellId: 'cell', invocationId: 'call', name: 'remote', args: {}, origin: { sessionId: f.id }, signal: new AbortController().signal })).toEqual(transformed)
    expect(f.document.view.events.find(event => event.type === 'code/result')).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: transformed } } })
  } finally { await broker.dispose(); await f.close() }
})
