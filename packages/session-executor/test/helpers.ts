// Shared test helpers for this package.
import { rmSync } from "node:fs"
import { append, committedFactSeqs, isNondurableSession, type FactOwner, type SessionView, type SessionEvent } from '@i-harness/core-session'

/** Arrange owned test history through the existing specific fact constructors. */
export async function recordFixture(owner: FactOwner, event: SessionEvent): Promise<void> {
  const action = owner.beginAction()
  try {
    const facts = action.facts
    switch (event.type) {
      case 'turn/start': case 'turn/end': case 'step/start': case 'step/end': case 'step/failed':
      case 'conversation/semantics': case 'assistant/chunk': case 'reasoning': case 'model/retry':
        committedFactSeqs(await facts.agent.lifecycle(event)); return
      case 'user/message':
        committedFactSeqs(await facts.agent.feedback({ ...event, source: event.source ?? { kind: 'plugin', plugin: 'fixture' } })); return
      case 'assistant/message': committedFactSeqs(await facts.agent.auditAssistant(event)); return
      case 'todo/write': case 'sandbox/mode': case 'plan/mode': case 'session/title':
        committedFactSeqs(await facts.metadata.admit(event)); return
      default: throw new Error(`Fixture requires its specific source for ${event.type}`)
    }
  } finally { action.finish() }
}

/** Explicit standalone fixture setup. Managed views use their real fact ports. */
export function appendStandalone(session:SessionView,event:SessionEvent):void{
  if(!isNondurableSession(session))throw new TypeError('Managed fixture requires actual fact admission')
  append(session,event)
}

/**
 * Remove a test workspace, tolerating Windows' delayed handle release.
 *
 * WHY: the PTY/terminal tests spawn a real child whose ConPTY handles are not
 * released at the instant `assembly.dispose()` resolves — the kernel closes
 * them asynchronously. An immediate `rmSync` then throws
 * `EBUSY: resource busy or locked, rmdir '…'` from the `finally` block, which
 * surfaces as a TEST FAILURE even though every assertion already passed.
 * (Lived experience: `workspace-cwd.test.ts` "terminal_open spawns the PTY in
 * the assembly workspace" red only under full-suite load — the assertion was
 * green, the cleanup was not.)
 *
 * `force: true` suppresses ENOENT only; it does NOT suppress EBUSY, so a plain
 * retry loop over the rm is the honest fix. Bounded: a genuine leak still
 * fails, it just takes ~1.5s longer to say so. Non-Windows callers are
 * unaffected (the first attempt succeeds and the loop exits).
 */
export function rmWorkspaceSync(path: string, attempts = 10, delayMs = 150): void {
  for (let i = 1; ; i++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM"
      if (!retryable || i >= attempts) throw error
      // Synchronous sleep: these callers are inside `finally` blocks in sync
      // teardown code. 150ms is enough for ConPTY to drop the last handle in
      // every observed case; the budget caps at ~1.5s.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
    }
  }
}
