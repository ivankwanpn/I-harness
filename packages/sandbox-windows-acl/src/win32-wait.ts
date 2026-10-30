import koffi from 'koffi'
import type { NativePtr } from './ffi.ts'
import { Win32Error } from './errors.ts'
import { createRegisteredWait } from './native-wait.ts'
import { WaitDrainTransportError, type WaitDrainService } from './native-wait-bridge.ts'

// Anonymous and module-stable: each channel/generation must not redeclare a named prototype.
const callbackType = koffi.proto('__stdcall', 'void', ['void *', 'uint8'])

/** One-shot kernel wait. Partial registration allocations remain owned by close(). */
export function registerWin32Wait(handle: NativePtr, service: Pick<WaitDrainService, 'reserve'>) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Win32 wait requires Windows x64')
  const kernel = koffi.load('kernel32.dll')
  const ptr = koffi.pointer('void')
  const register = kernel.func('__stdcall', 'RegisterWaitForSingleObject', 'int', [koffi.pointer(ptr), ptr, koffi.pointer(callbackType), ptr, 'uint32', 'uint32'])
  const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32', [])
  const reservation = service.reserve() // Admission before any native wait can exist.
  let trampoline: ReturnType<typeof koffi.register> | undefined
  let slot: ReturnType<typeof koffi.alloc> | undefined
  let registrationFailure: unknown
  let nativeRegistered = false
  let issueUnknown = false
  const wait = createRegisteredWait<NativePtr | undefined>({
    register(callback) {
      try {
        slot = koffi.alloc(ptr, 1)
        koffi.encode(slot, ptr, null)
        trampoline = koffi.register(() => { try { callback() } catch { /* Never unwind through Win32. */ } }, koffi.pointer(callbackType))
        let ok: unknown
        try { ok = register(slot, handle, trampoline, null, 0xffffffff, 0x8) } catch (error) { issueUnknown = true; throw error }
        if (!ok) {
          const code = lastError() as number
          throw new Win32Error('RegisterWaitForSingleObject', code)
        }
        nativeRegistered = true
        return koffi.decode(slot, ptr) as NativePtr
      } catch (error) {
        registrationFailure = error
        return undefined
      }
    },
    // If decoding failed after successful registration, retry decoding the retained
    // out-slot. Never interpret that exception as evidence of no native wait.
    unregister: registration => {
      if (!nativeRegistered && !issueUnknown) return Promise.resolve(0)
      let address: NativePtr
      try { address = registration ?? koffi.decode(slot!, ptr) as NativePtr } catch (error) {
        throw new WaitDrainTransportError('not-dispatched', `registration decode failed before unregister dispatch: ${String(error)}`)
      }
      if (address === null || address === undefined || address === 0n) throw new WaitDrainTransportError('unknown', 'native wait issue outcome unknown without a recoverable registration')
      return reservation.unregister(address)
    },
    rejoin: () => reservation.rejoin(),
    release() {
      if (trampoline !== undefined) { koffi.unregister(trampoline); trampoline = undefined }
      if (slot !== undefined) { koffi.free(slot); slot = undefined }
      reservation.release()
    },
  })
  return { signalled: registrationFailure === undefined ? wait.signalled : Promise.reject(registrationFailure), close: wait.close }
}
