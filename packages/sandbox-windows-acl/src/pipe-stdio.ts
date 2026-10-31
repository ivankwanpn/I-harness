import type { NativePtr } from './ffi.ts'
import { NativeInitOwner } from './init-owner.ts'
import type { ChildStdioHandles } from './startup-attributes.ts'

/** Original owner retains all handles until each close is acknowledged. */
export function acquireChildStdio(owner: NativeInitOwner, stdoutWriter: NativePtr, stderrWriter: NativePtr): ChildStdioHandles {
  const api = owner.api, current = owner.captureCurrent()
  const readSlot = owner.slot(); current()
  const writeSlot = owner.slot(); current()
  const [read, write] = owner.outputHandlePair(readSlot, writeSlot, 'CreatePipe', () => { current(); return api.createPipe(readSlot, writeSlot, null, 0) })
  current(); const readCurrent = owner.captureHandleCurrent(read)
  const process = api.getCurrentProcess(); current(); readCurrent()
  const duplicate = (source: NativePtr) => {
    current(); readCurrent()
    const slot = owner.slot(); current()
    const value = owner.output(slot, 'handle', 'DuplicateHandle', () => { current(); readCurrent(); return api.duplicateHandle(process, source, process, slot, 0, 1, 2) })
    current(); owner.captureHandleCurrent(value)(); return value
  }
  const handles: ChildStdioHandles = [duplicate(read), duplicate(stdoutWriter), duplicate(stderrWriter)]
  current(); owner.release(write, 'handle')
  // Intentional EOF retirement expires the old finite session. Reborrow only
  // exact still-live originals, without reviving any retired/unknown entries.
  owner.captureHandleCurrent(read)(); handles.forEach(handle => owner.captureHandleCurrent(handle)())
  owner.release(read, 'handle')
  handles.forEach(handle => owner.captureHandleCurrent(handle)())
  return handles
}
