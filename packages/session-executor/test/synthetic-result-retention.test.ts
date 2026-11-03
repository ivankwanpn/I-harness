import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createContext } from '@i-harness/core-plugin'
import { createAgent } from '@i-harness/core-agent'
import { createToolRegistry, declareToolResultOutcome, TOOL_FAILED } from '@i-harness/core-tools'
import { deriveMessages, type ImageInput, type ManagedArtifactRef, type ResultDependencyCatalog } from '@i-harness/core-session'
import { createContextOutputService } from '@i-harness/context-output'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { execResultOutcome, withExecCallerScope } from '@i-harness/exec'
import { createToolResultRetention } from '../src/lifecycle/result-retention.ts'
import { createExecResultRetention } from '../src/lifecycle/exec-result-retention.ts'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { controlledModel } from './controlled-model.ts'
// Shared test fixtures only, not cross-package production dependencies.
import { nativeFixture } from '../../exec/test/native-fixture.ts'
import { PNG, JPEG } from '../../image-validation/test/fixtures.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-results-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: join(root, 'context'), workspaceId: 'synthetic-fixture', config: { enabled: false } })
  const ctx = createContext(), tools = createToolRegistry(ctx, { resultRetention: createToolResultRetention(service, undefined, id) })
  return { root, backend, coordinator, id, document, service, ctx, tools,
    async close() { await coordinator.close(); await service.close(); await rm(root, { recursive: true, force: true }) } }
}

async function coldBytes(f: Awaited<ReturnType<typeof fixture>>, ref: ManagedArtifactRef) {
  const cold = createContextOutputService({ root: join(f.root, 'context'), workspaceId: 'synthetic-fixture' })
  try {
    const chunks: Buffer[] = []; let offset = 0
    for (;;) {
      const page = await cold.readResult({ sessionId: f.id }, { ref, offset })
      chunks.push(page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64'))
      if (page.eof) break
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset!
    }
    const bytes = Buffer.concat(chunks)
    expect(bytes.length).toBe(ref.encodedBytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.contentDigest)
    return bytes
  } finally { await cold.close() }
}
async function coldValue(f: Awaited<ReturnType<typeof fixture>>, ref: ManagedArtifactRef) { return JSON.parse((await coldBytes(f, ref)).toString()) }

it('retains the whole genuine scheduler body-failure reason once through the managed source with no post-body hook replay', async () => {
  const f = await fixture()
  const reason = 'actually failed after execution: ' + '中文🙂"\\\0'.repeat(15000)
  let bodies = 0, hooks = 0, postTools = 0, sends = 0, projections = 0
  f.tools.register({ name: 'fail', description: 'actual body failure', inputSchema: {}, async execute() { bodies++; throw new Error(reason) } })
  f.ctx.on('tools/post-execute', () => { hooks++ }); f.ctx.on('agent/post-tool', () => { postTools++ })
  f.ctx.onCascade('tools/project-synthetic-result', async (_input, next) => { projections++; return next() })
  const agent = createAgent(f.ctx, { generationFactory: action => createGenerationLifecycle(f.document.view, f.id, action), session: f.document.view, factOwner: f.document,
    tools: f.tools, sessionId: f.id, systemPrompt: '', model: controlledModel(async function* () {
      if (++sends === 1) yield { type: 'tool_call', call: { id: 'failed-once', name: 'fail', args: {} } }
      else yield { type: 'text/chunk', text: 'observed failure' }
      yield { type: 'end' }
    }) })
  try {
    await agent.run('one failed original')
    await f.document.drain!()
    const results = f.document.view.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    const result = results[0]!
    expect(result).toMatchObject({ callId: 'failed-once', envelope: { execution: { outcome: 'failed', dispatch: 'dispatched' }, retention: { kind: 'artifact' } } })
    if (result.envelope?.retention.kind !== 'artifact') throw new Error('Expected original failed body artifact')
    expect(result).not.toHaveProperty('output')
    expect(Buffer.byteLength(JSON.stringify(result.envelope))).toBeLessThanOrEqual(64000)
    expect(await coldValue(f, result.envelope.retention.ref)).toEqual({ error: reason, code: TOOL_FAILED })
    expect((await f.backend.read(f.id)).events.filter(event => event.type === 'tool/result')).toEqual(results)
    for (const message of deriveMessages(f.document.view).filter(message => message.role === 'tool')) {
      expect(message.isError).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(64000)
    }
    expect({ bodies, hooks, postTools, projections, sends }).toEqual({ bodies: 1, hooks: 0, postTools: 0, projections: 1, sends: 2 })
  } finally { await f.close() }
})

it('retains an actual native timeout partial, trusted failed outcome and ordered supported media while payload codes stay data', async () => {
  const f = await fixture(), full = 'native partial 中文🙂'.repeat(10000)
  const images: ImageInput[] = [{ mediaType: 'image/png', dataBase64: PNG }, { mediaType: 'image/jpeg', dataBase64: JPEG }]
  const native = nativeFixture({ liveTree: true, text: full, resultRetention: createExecResultRetention(f.service, 1024) })
  let bodies = 0, hooks = 0, sends = 0
  f.tools.register({ name: 'slow', description: 'actual native timeout', inputSchema: {}, async execute(_args, exec) {
    bodies++
    const result = await withExecCallerScope({ sessionId: f.id }, () => native.exec.run({ argv: ['fixture'], timeoutMs: 20 }))
    // Exact original exec identity supplies the outcome, before copying its DTO.
    declareToolResultOutcome(exec, execResultOutcome(result)!)
    return { ...result, images, code: TOOL_FAILED, error: 'payload data', detail: full }
  } })
  f.tools.register({ name: 'collision', description: 'ordinary lookalike', inputSchema: {}, async execute() { bodies++; return { code: 'TOOL_TIMEOUT', error: 'payload data', images: { mediaType: 'lookalike' }, detail: full } } })
  f.ctx.on('tools/post-execute', () => { hooks++ })
  const agent = createAgent(f.ctx, { generationFactory: action => createGenerationLifecycle(f.document.view, f.id, action), session: f.document.view, factOwner: f.document,
    tools: f.tools, sessionId: f.id, systemPrompt: '', model: controlledModel(async function* () {
      if (++sends <= 2) yield { type: 'tool_call', call: { id: 'original-' + sends, name: sends === 1 ? 'slow' : 'collision', args: {} } }
      else yield { type: 'text/chunk', text: 'done' }
      yield { type: 'end' }
    }) })
  try {
    await agent.run('observe actual timeout and lookalike')
    const results = f.document.view.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    const [timeout, collision] = results
    expect(timeout).toMatchObject({ envelope: { execution: { outcome: 'failed', dispatch: 'dispatched' }, media: images, dependencies: { kind: 'artifact-set', count: 1 } } })
    expect(collision).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, media: [] } })
    if (timeout?.envelope?.dependencies?.kind !== 'artifact-set') throw new Error('Expected original native dependency catalog')
    const catalog = await coldValue(f, timeout.envelope.dependencies.ref) as ResultDependencyCatalog
    expect(catalog.entries).toHaveLength(1)
    const dependency = catalog.entries[0]!
    if (dependency.retention.kind !== 'artifact') throw new Error('Expected captured original native frames')
    expect(dependency.retention.ref.completeness).toBe('capture-canceled')
    const frames = await coldBytes(f, dependency.retention.ref)
    expect(frames.subarray(0, 9).toString()).toBe('IHEXEC01\n')
    const records = frames.subarray(9).toString().trim().split('\n').map(line => JSON.parse(line))
    expect(records.every(record => record.channel === 'stdout')).toBe(true)
    expect(Buffer.concat(records.map(record => Buffer.from(record.data, 'base64'))).toString()).toBe(full)
    for (const result of results) {
      if (result.envelope?.retention.kind !== 'artifact') throw new Error('Expected original partial payload artifact')
      expect(Buffer.byteLength(JSON.stringify({ ...result.envelope, media: [] }))).toBeLessThanOrEqual(64000)
      const original = await coldValue(f, result.envelope.retention.ref)
      if (result.name === 'slow') {
        expect(original).toMatchObject({ timedOut: true, exitCode: 0, stderr: '', detail: full, images, code: TOOL_FAILED, error: 'payload data' })
        expect(original.truncated).toEqual({ stdout: true, stderr: false })
        expect(Buffer.byteLength(original.stdout)).toBeLessThanOrEqual(1024)
        expect(original.stdout).toBe('native partial 中文🙂'.repeat(40) + 'native partial 中文')
      } else expect(original).toEqual({ code: 'TOOL_TIMEOUT', error: 'payload data', images: { mediaType: 'lookalike' }, detail: full })
    }
    const messages = deriveMessages(f.document.view).filter(message => message.role === 'tool')
    for (const message of messages) expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(64000)
    expect(messages.find(message => message.toolCallId === 'original-1')?.isError).toBe(true)
    expect(messages.find(message => message.toolCallId === 'original-2')?.isError).toBeUndefined()
    expect(native.counts()).toEqual({ launches: 1, terminations: 1, releases: 1 })
    expect({ bodies, hooks, sends }).toEqual({ bodies: 2, hooks: 2, sends: 3 })
  } finally { native.finish(); await native.exec.dispose(); await f.close() }
})
