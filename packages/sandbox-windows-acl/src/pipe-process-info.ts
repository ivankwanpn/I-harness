import koffi from 'koffi'
import type { NativePtr } from './ffi.ts'
import { NativeInitOwner } from './init-owner.ts'
import { PROCESS_INFORMATION_SIZE } from './win32-abi.ts'

type Source = { issue(): number; lastError(): number; readProcess(): bigint; readThread(): bigint; readPid(): number }
/** Single-issue state around the original out-slot. Each decoded value is retained independently. */
export function createProcessInfoState(source: Source) {
  let phase: 'not-issued' | 'issuing' | 'failed' | 'created' | 'unknown' = 'not-issued'
  let process: bigint | undefined, thread: bigint | undefined, pid: number | undefined
  function requireCreated() { if (phase !== 'created') throw new Error('process creation not acknowledged') }
  function handle(value: bigint) { if (typeof value !== 'bigint' || value <= 0n || value >= 0xffffffffffffffffn) throw new Error('invalid process information handle'); return value }
  return {
    phase: () => phase,
    issue() {
      if (phase !== 'not-issued') throw new Error('process creation already issued')
      phase = 'issuing'
      let result: number
      try { result = source.issue() } catch (cause) { phase = 'unknown'; throw new Error('process creation outcome unknown', { cause }) }
      if (typeof result !== 'number' || !Number.isInteger(result) || result < -2147483648 || result > 2147483647) { phase = 'unknown'; throw new Error('process creation outcome unknown') }
      if (result === 0) { phase = 'failed'; const code = source.lastError(); throw new Error(`CreateProcessAsUserW failed (${code})`) }
      phase = 'created'
    },
    process() { requireCreated(); return process ??= handle(source.readProcess()) },
    thread() { requireCreated(); return thread ??= handle(source.readThread()) },
    pid() { requireCreated(); if (pid === undefined) { const value = source.readPid(); if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) throw new Error('invalid process id'); pid = value } return pid },
  }
}

/** Owns original PROCESS_INFORMATION storage in the caller's child-local scope. */
export function createProcessInfoSlot(owner: NativeInitOwner, issue: (slot: NativePtr) => number) {
  const slot = owner.bytes(PROCESS_INFORMATION_SIZE)
  const view = new DataView(koffi.view(slot, PROCESS_INFORMATION_SIZE))
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0)
  const state = createProcessInfoState({ issue: () => issue(slot), lastError: () => owner.api.getLastError(),
    readProcess: () => view.getBigUint64(0, true), readThread: () => view.getBigUint64(8, true), readPid: () => view.getUint32(16, true) })
  return { ...state, slot }
}
