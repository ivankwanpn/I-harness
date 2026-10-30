import koffi from 'koffi'
import type { NativePtr } from './ffi.ts'
import { NativeInitOwner } from './init-owner.ts'

/** Convert the original copied, token-derived logon SID while its input remains
 * live. Shape validation checks representation, never host identity/authenticity.
 * The original owner retains the LocalAlloc output until acknowledged free. */
export function logonSidText(owner: NativeInitOwner, sid: NativePtr): string {
  const current = owner.captureHeapCurrent(sid)
  current()
  const slot = owner.slot()
  current()
  const pointer = owner.output(slot, 'local', 'ConvertSidToStringSidW', () => {
    current()
    const result = owner.api.convertSidToStringSidW(sid, slot)
    if (!Number.isInteger(result) || result < -0x80000000 || result > 0x7fffffff) throw new Error('ConvertSidToStringSidW outcome unknown')
    return result
  })
  current()
  const result: unknown = koffi.decode(pointer, 'char16', -1)
  current()
  if (typeof result !== 'string' || !/^S-1-5-5-[0-9]+-[0-9]+$/.test(result)) throw new Error('Invalid converted logon SID text')
  owner.release(pointer, 'local')
  // This intentional acknowledged retirement expires current. Only copied JS
  // text is used from here; no stale guard/native pointer access follows.
  return result
}
