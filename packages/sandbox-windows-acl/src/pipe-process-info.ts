import koffi from 'koffi'
import type { NativePtr } from './ffi.ts'
import { NativeInitOwner } from './init-owner.ts'
import { Win32Error } from './errors.ts'
import { PROCESS_INFORMATION_SIZE } from './win32-abi.ts'

type Source = { issue(): number; lastError(): number; readProcess(): bigint; readThread(): bigint; readPid(): number }
/** Single-issue state around the original out-slot. Unknown outputs may be
 * recovered, but reading them never upgrades the launch acknowledgment. */
export function createProcessInfoState(source: Source) {
  let phase: 'not-issued' | 'issuing' | 'failed' | 'created' | 'unknown' = 'not-issued'
  let process: bigint | undefined, thread: bigint | undefined, pid: number | undefined
  let handedOff = false
  function requireOutputs() { if (phase !== 'created' && phase !== 'unknown') throw new Error('process outputs unavailable') }
  function handle(value: bigint) { if (typeof value !== 'bigint' || value <= 0n || value >= 0xffffffffffffffffn) throw new Error('invalid process information handle'); return value }
  return {
    phase: () => phase,
    issue() {
      if (phase !== 'not-issued') throw new Error('process creation already issued')
      phase = 'issuing'
      let result: number
      try { result = source.issue() } catch (cause) { phase = 'unknown'; throw new Error('process creation outcome unknown', { cause }) }
      if (typeof result !== 'number' || !Number.isInteger(result) || result < -2147483648 || result > 2147483647) { phase = 'unknown'; throw new Error('process creation outcome unknown') }
      if (result === 0) { phase = 'failed'; const code = source.lastError(); throw new Win32Error('CreateProcessAsUserW', code) }
      phase = 'created'
    },
    process() { requireOutputs(); return process ??= handle(source.readProcess()) },
    thread() { requireOutputs(); return thread ??= handle(source.readThread()) },
    pid() { requireOutputs(); if (pid === undefined) { const value = source.readPid(); if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) throw new Error('invalid process id'); pid = value } return pid },
    /** The caller acknowledges that an original external owner now retains the
     * recovered handles and all launch/root debt, including an unknown launch.
     * The caller also acknowledges no outstanding native access to this slot.
     * This is a storage handoff only: no handle close or launch ACK is implied.
     * Requires already cached outputs; never performs a native read. */
    acknowledgeOutputHandoff() {
      requireOutputs()
      if (process === undefined || thread === undefined || pid === undefined) throw new Error('original process outputs remain unresolved')
      handedOff = true
    },
    assertRetirable() {
      if (phase !== 'not-issued' && phase !== 'failed' && !handedOff) throw new Error('original process output recovery/handoff remains incomplete')
    },
  }
}

/** Owns original PROCESS_INFORMATION storage in the caller's local scope.
 * Raw pointers are borrowed only until the next original-owner retirement
 * attempt. Issuing/unknown/unhanded outputs pin this storage on that same owner.
 * An invalidated native-use session cannot be revived by a cleanup retry. */
export function createProcessInfoSlot(owner: NativeInitOwner, issue: (slot: NativePtr) => number) {
  const current = owner.captureCurrent()
  current()
  const slot = owner.bytes(PROCESS_INFORMATION_SIZE)
  current()
  let view: DataView
  const state = createProcessInfoState({
    issue: () => { current(); return issue(slot) }, lastError: () => owner.api.getLastError(),
    readProcess: () => { current(); return view.getBigUint64(0, true) },
    readThread: () => { current(); return view.getBigUint64(8, true) },
    readPid: () => { current(); return view.getUint32(16, true) },
  })
  // Reverse retirement checks this gate before freeing the underlying bytes.
  // It is a non-consuming check, so acknowledged handoff can unblock only the
  // original allocation; it never resubmits a native close/free operation.
  owner.retirementGate(slot, () => state.assertRetirable())
  current()
  const buffer = koffi.view(slot, PROCESS_INFORMATION_SIZE)
  current()
  view = new DataView(buffer)
  current()
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0)
  current()
  return Object.freeze({
    phase: state.phase,
    issue() { current(); state.issue() },
    process: state.process, thread: state.thread, pid: state.pid,
    acknowledgeOutputHandoff: state.acknowledgeOutputHandoff,
    get slot() { current(); return slot },
  })
}
