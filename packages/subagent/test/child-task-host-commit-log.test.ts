import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { append, createSession, exportConversationSeed } from '@i-harness/core-session'
import {
  captureChildBootstrapCaptureRequest,
  captureChildBootstrapCore,
  childInitialCommitment,
  childRoleDigest,
  compileSemanticSeed,
  createChildBootstrapRequestIntent,
} from '@i-harness/session-persistence'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { createUnmanagedTaskChildHost } from '../../session-executor/src/lifecycle/task-child-host.ts'
import { verifyOriginalChildBirth } from '../src/child/task-birth.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('unmanaged task-child host on the commit log', () => {
  it('runs the prepared child through the observation scope and verifies the birth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ih-task-host-scl-'))
    roots.push(root)
    const coordinator = createJsonlCommitCoordinator(root, { lock: { enabled: true } })
    try {
      await coordinator.create({ sessionId: 'parent' })
      const facade = asSessionCoordinator(coordinator)
      const source = createSession()
      append(source, { type: 'user/message', text: 'source' })
      const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
      if (exported.kind !== 'seed') throw new Error('seed refused')
      const seed = compileSemanticSeed(exported)
      const initial = { inputId: 'initial-1', text: 'do the task', parentSessionId: 'parent', startedAt: 100, expiresAt: 200 }
      const basePayload = {
        invocation: { version: 1 as const, operationId: 'task-op', targetSessionId: 'child-task', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'e'.repeat(64) },
        target: { kind: 'new' as const },
        metadata: {},
        lineage: { origin: 'subagent' as const, subagentProtocolVersion: 1 as const, parentSession: 'parent', delegationDepth: 1 },
        seed,
        initial,
      }
      const commitment = childInitialCommitment(basePayload as never)
      const core = captureChildBootstrapCore({
        version: 1,
        kind: 'child-bootstrap-core',
        caller: { kind: 'task', taskId: 'task-1', parentSessionId: 'parent' },
        history: { selection: { kind: 'none' } },
        metadata: {},
        lineage: basePayload.lineage,
        initial: commitment,
        execution: {
          roleName: 'general',
          roleDigest: childRoleDigest({ name: 'general', systemPrompt: 'p', tools: [] }),
          toolNames: [],
          model: { kind: 'inherit-parent' },
          approval: 'ordinary',
        },
      })
      const intent = createChildBootstrapRequestIntent(core, { kind: 'unmanaged' })
      const request = captureChildBootstrapCaptureRequest({
        version: 1,
        kind: 'child-bootstrap-capture-request',
        invocation: { ...basePayload.invocation, requestDigest: intent.requestDigest },
        core,
        requestIntent: intent.intent,
      })
      const payload = { ...basePayload, invocation: request.invocation }
      const prepare = createUnmanagedTaskChildHost({ coordinator: facade, policy: 'unmanaged' })
      const host = await prepare({
        coordinator: facade,
        parentSessionId: 'parent',
        assertCurrent() {},
        assertSourceCut() {},
        sourceAvailable: () => true,
        retire() {},
        retain() {},
      })
      const transfer = host.prepare(request)
      const outcome = await transfer.run(guards => facade.bootstrapChildTargetWithCapture!(request, guards, async () => payload))
      expect(outcome.kind).toBe('ready')
      if (outcome.kind !== 'ready') throw new Error('expected ready')
      verifyOriginalChildBirth({ document: outcome.document, receipt: outcome.receipt, request, payload }, 'subagent', 'parent')
      await coordinator.closeManagedDocument('child-task')
      const { session } = await coordinator.load('child-task')
      expect(session.header).toMatchObject({ parentSession: 'parent', origin: 'subagent', seedLength: seed.records.length })
    } finally { await coordinator.close() }
  }, 30000)
})
