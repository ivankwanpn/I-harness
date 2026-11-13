import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { append, createSession, exportConversationSeed } from '@i-harness/core-session'
import { createSessionCoordinator, compileSemanticSeed, readForkRequestCore, createBootstrapRequestIntent, type BootstrapRequest } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'

it.each(['plain', 'captured'] as const)('%s original cold header survives both shorter and longer presentation edits', async mode => {
  for (const [title, next] of [['x'.repeat(2000), 'x'], ['x', 'x'.repeat(2000)]]) {
    const root = await mkdtemp(join(tmpdir(), 'ih-header-resize-'))
    const backend = createJsonlBackend(root)
    const coordinator = createSessionCoordinator(backend)
    const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('no artifacts') }, async reconcile() { throw Error('no artifacts') } } }
    try {
      const core = readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: { title } })
      const intent = createBootstrapRequestIntent(core, { kind: 'unmanaged' })
      const invocation = { version: 1 as const, operationId: 'birth', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: intent.requestDigest }
      const source = createSession()
      append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'original' }); append(source, { type: 'turn/end' })
      const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'source' }, { kind: 'completed' })
      if (exported.kind !== 'seed') throw Error('original seed unavailable')
      const payload: BootstrapRequest = { invocation, target: { kind: 'new' }, metadata: { title }, lineage: { origin: 'fork', parentSession: 'source' }, seed: compileSemanticSeed(exported) }
      const first = mode === 'captured' ? await coordinator.bootstrapSemanticTargetWithCapture!({ invocation, core, requestIntent: intent.intent }, guards, async () => payload) : await coordinator.bootstrapSemanticTarget(payload, guards)
      expect(first.kind).toBe('ready')
      await coordinator.updateMeta('target', { title: next })
      await coordinator.close()
      const before = await readFile(join(root, 'target.jsonl'))
      const cold = createSessionCoordinator(createJsonlBackend(root))
      try {
        const resumed = await cold.resumeSemanticTarget(invocation, guards, payload)
        expect(resumed.kind).toBe('already-ready')
        expect(await readFile(join(root, 'target.jsonl'))).toEqual(before)
      } finally { await cold.close() }
    } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
  }
}, 15000)
