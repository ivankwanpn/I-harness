import { mock } from 'node:test'
import { open, type FileHandle } from 'node:fs/promises'
import type { EncodedFactBatch, SessionEvent, FactOutcome } from '@i-harness/core-session'

export type Cut = 'setup' | 'before-issue' | 'partial-unknown' | 'complete-unknown' | 'receipt-withheld' | 'install'
export interface FaultState {
  armed: boolean; factories: number; stages: number; installs: number; selectedInstalls: number; selectedObservations: number
  installOutcomes: FactOutcome[]
  installThrows: { sameOutcome: boolean; code?: string }[]
  target?(events: readonly SessionEvent[]): boolean
}

/** Child-only interception: the actual view, owner binding and staging stay intact. */
export async function installStageProbe(state: FaultState) {
  const actual = await import('@i-harness/core-session')
  mock.module(import.meta.resolve('@i-harness/core-session'), { cache: true, namedExports: {
    ...actual,
    committedFactSeqs(...args: Parameters<typeof actual.committedFactSeqs>) {
      const outcome = args[0]
      if (outcome.kind === 'recovery-required' && outcome.code === 'FACT_INSTALL_FAILED') state.installOutcomes.push(outcome)
      try { return actual.committedFactSeqs(...args) }
      catch (error) {
        if (outcome.kind === 'recovery-required' && outcome.code === 'FACT_INSTALL_FAILED') {
          const original = error as { code?: string; outcome?: unknown }
          state.installThrows.push({ sameOutcome: original.outcome === outcome, code: original.code })
        }
        throw error
      }
    },
    createManagedSessionState(...args: Parameters<typeof actual.createManagedSessionState>) {
      state.factories++
      const original = actual.createManagedSessionState(...args)
      return { ...original, stage(events: SessionEvent[]) {
        state.stages++
        const staged = original.stage(events), selected = state.target?.(staged.events) === true
        return { ...staged, install() {
          if (selected) {
            state.selectedInstalls++
            if (state.armed) throw new Error('controlled original staged install failure')
          }
          staged.install(); state.installs++
        } }
      }, observe(events: readonly SessionEvent[], report: (error: unknown) => void) {
        if (state.target?.(events)) state.selectedObservations++
        original.observe(events, report)
      } }
    },
  } })
  return actual
}

/** Observe the actual runtime's admitted guest output before original fact
 * publication; a missing durable output alone is not a guest-work counter. */
export async function installGuestProbe(onFulfilled: () => void) {
  const actual = await import('../../../code-mode/src/runtime.ts')
  mock.module(import.meta.resolve('../../../code-mode/src/runtime.ts'), { cache: true, namedExports: {
    ...actual, createCodeModeRuntime(...args: Parameters<typeof actual.createCodeModeRuntime>) {
      const options = args[0]
      return actual.createCodeModeRuntime({ ...options, onEvent(event) {
        if (event.type === 'output' && event.item.type === 'text' && event.item.text === 'guest-fulfilled') onFulfilled()
        return options.onEvent?.(event)
      } })
    },
  } })
}

export async function installPhysicalFault(root: string) {
  const probe = await open(root + '/filehandle-probe', 'w+')
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  const write = prototype.write, sync = prototype.sync, truncate = prototype.truncate
  await probe.close()
  let target: EncodedFactBatch | undefined, cut: Cut | undefined, handle: FileHandle | undefined
  const measured = { writes: 0, writtenBytes: 0, nativeSyncs: 0, refusedRollbacks: 0 }
  // Only the exact encoded batch byte object can select the journal handle.
  prototype.write = async function (this: FileHandle, ...args: unknown[]) {
    if (!target || args[0] !== target.bytes) return Reflect.apply(write, this, args) as ReturnType<FileHandle['write']>
    handle = this; measured.writes++
    if (cut === 'partial-unknown') {
      const result = await Reflect.apply(write, this, [target.bytes, 0, 17, args[3]]) as { bytesWritten: number }
      measured.writtenBytes += result.bytesWritten
      await sync.call(this); measured.nativeSyncs++
      throw new Error('controlled failure after physical17byte write and native sync')
    }
    const result = await Reflect.apply(write, this, args) as { bytesWritten: number }
    measured.writtenBytes += result.bytesWritten
    return result
  } as FileHandle['write']
  prototype.sync = async function () {
    if (this !== handle || cut !== 'complete-unknown') return sync.call(this)
    await sync.call(this); measured.nativeSyncs++
    throw new Error('controlled lost durability evidence after successful native sync')
  }
  prototype.truncate = async function (length?: number) {
    if (this === handle && (cut === 'partial-unknown' || cut === 'complete-unknown')) {
      measured.refusedRollbacks++
      throw new Error('controlled same-handle rollback refusal')
    }
    return truncate.call(this, length)
  }
  return { measured, arm(batch: EncodedFactBatch, selected: Cut) { target = batch; cut = selected } }
}
