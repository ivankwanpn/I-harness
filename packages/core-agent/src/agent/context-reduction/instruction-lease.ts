import type { AgentDeps } from '../types.ts'
import type { InstructionRequestEvidence, RequestContextPin } from '../request-context.ts'
import { savingFailure } from '../saving-failure.ts'

/** The original run source waits for a finite run-done prerequisite. */
export async function withInstructionRun<T>(deps: AgentDeps, signal: AbortSignal | undefined, operation: (retain: (evidence?: InstructionRequestEvidence) => void) => Promise<T>): Promise<T> {
  await deps.requestContext?.reconcile(signal)
  if (!deps.requestContext) return operation(() => {})
  if (!deps.registerFactSource) throw new Error('Instruction reduction requires original run source')
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve }), pins = new Map<InstructionRequestEvidence, RequestContextPin>()
  const source = deps.registerFactSource(async () => {
    await done
    for (const [evidence, pin] of pins) {
      try { await pin.release(); pins.delete(evidence) }
      catch (error) { source.holdRecovery(); throw error }
    }
  })
  let primary: unknown, failed = false
  try { return await operation(evidence => { if (evidence && !pins.has(evidence)) pins.set(evidence, deps.requestContext!.retain(evidence)) }) }
  catch (error) { primary = error; failed = true; throw error }
  finally {
    finish()
    try { await source.close() }
    catch (error) { if (failed) throw savingFailure(primary, [error], 'Instruction reduction run cleanup failed'); throw error }
  }
}
