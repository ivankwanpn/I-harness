import type { NativePtr } from './ffi.ts'
import { NativeInitOwner } from './init-owner.ts'
import type { ChildStdioHandles } from './startup-attributes.ts'

/** Original owner retains all handles until each close is acknowledged. */
export function acquireChildStdio(owner: NativeInitOwner, stdoutWriter: NativePtr, stderrWriter: NativePtr): ChildStdioHandles {
  const api = owner.api
  const readSlot = owner.slot(), writeSlot = owner.slot()
  const [read, write] = owner.outputHandlePair(readSlot, writeSlot, 'CreatePipe', () => api.createPipe(readSlot, writeSlot, null, 0))
  const process = api.getCurrentProcess()
  const duplicate = (source: NativePtr) => {
    const slot = owner.slot()
    return owner.output(slot, 'handle', 'DuplicateHandle', () => api.duplicateHandle(process, source, process, slot, 0, 1, 2))
  }
  const handles: ChildStdioHandles = [duplicate(read), duplicate(stdoutWriter), duplicate(stderrWriter)]
  owner.release(write, 'handle')
  owner.release(read, 'handle')
  return handles
}
