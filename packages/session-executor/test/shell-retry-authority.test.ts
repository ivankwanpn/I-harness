import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { committedFactSeqs } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createShellTools } from '@i-harness/shell'
import { createExecServiceWithReservation } from '../../exec/src/service.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createScopedExecWithReservation } from '../src/scoped-exec.ts'

it('refuses a genuine durable Shell claim without its original model Exec issuer', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'retry-authority-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  const ctx = createContext(), pair = createExecServiceWithReservation({ workspaceRoot: root })
  const registry = createToolRegistry(ctx, { executionOwner: { view: document.view, factOwner: document, context: ctx, sessionId: id } })
  let preparations = 0
  const scoped = createScopedExecWithReservation(pair, root, () => undefined, async () => { preparations++; return { kind: 'unavailable', reason: 'uncertified-call' } }, ctx)
  for (const tool of createShellTools({ exec: scoped.service, directEntry: scoped.direct, agentShell: () => ({ id: 'control', label: 'control', command: 'control', dialect: 'posix' }) })) registry.register(tool)
  try {
    const args = { command: 'must-not-launch' }
    const [callEventSeq] = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', name: 'shell', callId: 'durable', args }))
    committedFactSeqs(await action.facts.tools.dispatch('durable', { kind: 'prior', seq: callEventSeq!, expectedType: 'tool/call' }))
    const prepared = await registry.prepare({ name: 'shell', args }, action.signal, { session: document.view, sessionId: id, callId: 'durable', callEventSeq, settlementSource: source })
    await expect(registry.dispatch(prepared)).rejects.toThrow('Original model Exec issuer required')
    expect(preparations).toBe(0)
    expect(pair.service.listJobs()).toEqual([])
  } finally { await source.close(); action.finish(); await pair.service.dispose(); await ctx.scope.unmount(); await coordinator.close() }
})
