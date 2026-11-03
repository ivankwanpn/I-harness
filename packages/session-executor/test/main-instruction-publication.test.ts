import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import type { InstructionService } from '@i-harness/instructions'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createSessionService } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'

it('the original uncertain runtime publication keeps its staged view observed until real reconciliation and cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-publication-')); await writeFile(join(root, 'AGENTS.md'), 'ORIGINAL_PUBLICATION_TEXT')
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  let key: BatchKey | undefined, ready = false, issues = 0, sends = 0, closes = 0
  backend.appendOwnedBatch = async (...args) => {
    const outcome = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'runtime/context')) { key = args[3].key; issues++; return { kind: 'unknown', key } }
    return outcome
  }
  backend.reconcileOwnedBatch = (...args) => !ready && key?.batchId === args[3].key.batchId ? Promise.resolve({ kind: 'unknown', key: args[3].key }) : reconcile(...args)
  const environment = createProjectInstructionEnvironment(), create = environment.host.create.bind(environment.host), sources: InstructionService[] = []
  environment.host.create = scope => { const source = create(scope), close = source.close.bind(source); const observed = { ...source, async close() { closes++; await close() } }; sources.push(observed); return observed }
  const server = createServer((_request, response) => { sends++; response.writeHead(500).end('Unexpected instruction publication send') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const service = createSessionService({ workspace: root, coordinator, instructionEnvironment: environment, model: createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: `http://127.0.0.1:${address.port}` }), contextWindow: 100000, codeMode: { mode: 'off' } })
  try {
    await expect(service.submit(id, 'held original publication', new AbortController().signal)).rejects.toThrow()
    expect([issues, sends, sources.length]).toEqual([1, 0, 1])
    expect(closes).toBe(0)
    expect(sources[0]!.snapshot()).toMatchObject({ reliability: 'ready', complete: true })
    await expect(service.close()).rejects.toThrow()
    expect(closes).toBe(0)
    ready = true
    expect(await (await coordinator.openManagedDocument(id)).reconcile(key!)).toMatchObject({ kind: 'committed' })
    await service.close(); expect(closes).toBe(1); expect(issues).toBe(1); expect(sends).toBe(0)
  } finally { ready = true; await service.close(); await environment.close(); await coordinator.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmWorkspaceSync(root) }
})
