import koffi from 'koffi'
import type { NativePtr } from './ffi.ts'
import { NativeInitOwner } from './init-owner.ts'

/** Convert the already copied token SID, retaining the LocalAlloc output until acknowledged free. */
export function logonSidText(owner: NativeInitOwner, sid: NativePtr): string {
  const slot = owner.slot()
  const pointer = owner.output(slot, 'local', 'ConvertSidToStringSidW', () => owner.api.convertSidToStringSidW(sid, slot))
  const result: unknown = koffi.decode(pointer, 'str16')
  if (typeof result !== 'string' || !result) throw new Error('Invalid converted logon SID text')
  owner.release(pointer, 'local')
  return result
}
