import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_SEMANTIC_DEPENDENCY_DIGEST, append, createSession, exportConversationSeed } from '@i-harness/core-session'
import { bootstrapInitialInputDigest } from '@i-harness/core-session/internal/bootstrap'
import { compileSemanticSeed } from '@i-harness/session-persistence'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { verifyOriginalChildBirth } from '../src/child/task-birth.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function payload(suffix: string) {
  const source = createSession()
  append(source, { type: 'user/message', text: 'source' })
  const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
  if (exported.kind !== 'seed') throw new Error('seed refused')
  return {
    invocation: { version: 1 as const, operationId: 'op-' + suffix, targetSessionId: 'child-' + suffix, createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'd'.repeat(64) },
    target: { kind: 'new' as const },
    metadata: {},
    lineage: { origin: 'subagent' as const, parentSession: 'parent', delegationDepth: 1, subagentProtocolVersion: 1 as const },
    seed: compileSemanticSeed(exported),
    initial: { inputId: 'initial-' + suffix, text: 'do task', parentSessionId: 'parent', startedAt: 100, expiresAt: 200 },
  }
}

describe('original child birth verification accepts an SCL birth', () => {
  it('verifies a subagent birth produced in one commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ih-birth-verify-'))
    roots.push(root)
    const coordinator = createJsonlCommitCoordinator(root, { lock: { enabled: true } })
    try {
      const requestPayload = payload('a')
      const born = await coordinator.createChildSession(requestPayload, { closure: requestPayload.seed.dependencyDigest })
      const initialEvent = born.document.view.events[born.receipt.initial!.seq]!
      const request = { invocation: requestPayload.invocation, core: { initial: { inputId: requestPayload.initial.inputId, digest: bootstrapInitialInputDigest(initialEvent, requestPayload.initial.startedAt, requestPayload.initial.expiresAt), startedAt: requestPayload.initial.startedAt, expiresAt: requestPayload.initial.expiresAt, parentSessionId: requestPayload.initial.parentSessionId } } }
      verifyOriginalChildBirth({ document: born.document, receipt: born.receipt, request: request as never, payload: requestPayload }, 'subagent', 'parent')
      expect(born.receipt.seedLength).toBe(requestPayload.seed.records.length)
      expect(born.receipt.initial?.inputId).toBe('initial-a')
      await coordinator.closeManagedDocument('child-a')
    } finally { await coordinator.close() }
  })

  it('verifies a dependency-carrying birth against its closure digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ih-birth-verify-'))
    roots.push(root)
    const coordinator = createJsonlCommitCoordinator(root, { lock: { enabled: true } })
    try {
      const requestPayload = payload('b')
      const born = await coordinator.createChildSession(requestPayload, { closure: EMPTY_SEMANTIC_DEPENDENCY_DIGEST })
      const initialEvent = born.document.view.events[born.receipt.initial!.seq]!
      const request = { invocation: requestPayload.invocation, core: { initial: { inputId: requestPayload.initial.inputId, digest: bootstrapInitialInputDigest(initialEvent, requestPayload.initial.startedAt, requestPayload.initial.expiresAt), startedAt: requestPayload.initial.startedAt, expiresAt: requestPayload.initial.expiresAt, parentSessionId: requestPayload.initial.parentSessionId } } }
      verifyOriginalChildBirth({ document: born.document, receipt: born.receipt, request: request as never, payload: requestPayload }, 'subagent', 'parent')
      await coordinator.closeManagedDocument('child-b')
    } finally { await coordinator.close() }
  })
})
