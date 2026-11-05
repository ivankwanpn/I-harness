import { randomUUID } from 'node:crypto'
import { CURRENT_FORMAT_VERSION, FactRecoveryRequiredError, type SessionEventView } from '@i-harness/core-session'
import { restoreManagedExecutionState } from '@i-harness/core-session/internal/execution'
import type { OriginalConversationRestorationSource } from '@i-harness/core-session/internal/restoration'
import type { CommitLog } from '@i-harness/session-commit-log'
import type { ManagedExecutionAttachment } from '../execution-internal.ts'
import { commitPrefix, createCommitManagedContext, openCommitExecutionDocument, type CommitManagedContext, type CommitManagedDeps } from './managed.ts'

const closed = () => Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' })

/** Restoration source over the commit log: the fold is the history, a commit is
 *  the only write, and the prefix is always derived from the log. */
function executionSource(log: CommitLog, context: CommitManagedContext): OriginalConversationRestorationSource {
  const events = (): SessionEventView[] => log.view().entries as unknown as SessionEventView[]
  const assertCurrent = () => { if (!log.open) throw closed() }
  // The execution fence compares this exact object across reads; it is replaced
  // only when a committed batch advances the log.
  let prefix = Object.freeze(commitPrefix(log))
  return {
    get formatVersion() { return CURRENT_FORMAT_VERSION },
    get header() { return context.source.header },
    get prefix() { return prefix },
    assertCurrent,
    async consume(accept) { for (const event of events()) { assertCurrent(); await accept([event]) } },
    async readEvent(ordinal) { assertCurrent(); const event = events()[ordinal]; if (!event) throw new FactRecoveryRequiredError(); return event },
    async settle() { assertCurrent() },
    async close() { /* no retained read resources */ },
    appendCommitted() { prefix = Object.freeze(commitPrefix(log)) },
  }
}

/** One execution attachment over the commit log: restore the execution state
 *  from the folded history, then construct the document FROM that state so its
 *  delivery observation belongs to the execution fence. */
export async function openCommitExecution(sessionId: string, log: CommitLog, deps: CommitManagedDeps, foldFactory?: Parameters<typeof restoreManagedExecutionState>[2]): Promise<ManagedExecutionAttachment> {
  const context = createCommitManagedContext(sessionId, log, deps)
  const token = Object.freeze({ sessionId, incarnation: randomUUID() })
  const binding = {
    token,
    assertHeld() { if (!log.open) throw closed() },
    openDependencies(expected: ReturnType<typeof commitPrefix>) {
      const assertCurrent = () => {
        if (!log.open) throw closed()
        const current = commitPrefix(log)
        if (current.prefixDigest !== expected.prefixDigest || current.eventCount !== expected.eventCount) throw new TypeError('Writer prefix changed')
      }
      return {
        assertCurrent,
        async readEvent(ordinal: number) { assertCurrent(); const event = log.view().entries[ordinal]; if (!event) throw new FactRecoveryRequiredError(); return event as unknown as SessionEventView },
        async close() { /* no retained resources */ },
      }
    },
  }
  const state = await restoreManagedExecutionState(executionSource(log, context), binding as never, foldFactory)
  // createManagedDocument binds the execution core to this exact document.
  const document = openCommitExecutionDocument(sessionId, log, deps, state as unknown as object, token.incarnation)
  return Object.freeze({
    identity: state.identity,
    owner: document,
    prepare: () => state.prepare(),
    observe: () => state.observe(),
    prepareRequest: (action: Parameters<typeof state.prepareRequest>[0]) => state.prepareRequest(action),
    revokeNewWork: () => document.revokeNewWork(),
    close: async () => { await state.close() },
  }) as ManagedExecutionAttachment
}
