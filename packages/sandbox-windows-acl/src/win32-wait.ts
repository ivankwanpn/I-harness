import koffi from 'koffi'
import type { NativePtr } from './ffi.ts'
import { Win32Error } from './errors.ts'
import { createRegisteredWait } from './native-wait.ts'
import { WaitDrainTransportError, type WaitDrainReservation, type WaitDrainService } from './native-wait-bridge.ts'

// Anonymous and module-stable: each channel/generation must not redeclare a named prototype.
const callbackType = koffi.proto('__stdcall', 'void', ['void *', 'uint8'])

function bindNativeWait() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Win32 wait requires Windows x64')
  const kernel = koffi.load('kernel32.dll')
  const ptr = koffi.pointer('void')
  const register = kernel.func('__stdcall', 'RegisterWaitForSingleObject', 'int', [koffi.pointer(ptr), ptr, koffi.pointer(callbackType), ptr, 'uint32', 'uint32'])
  const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32', [])
  return { ptr, register, lastError }
}

/** One-shot kernel wait. Partial registration allocations remain owned by close(). */
export function registerWin32Wait(handle: NativePtr, service: Pick<WaitDrainService, 'reserve'>) {
  const prepared = bindNativeWait()
  return constructWin32Wait(handle, service.reserve(), prepared)
}

/** Accepts ownership at entry, including unsupported platform or binding/setup failure.
 * Every post-handoff failure returns a failed observer with original retryable cleanup. */
export function registerWin32WaitWithReservation(handle: NativePtr, reservation: WaitDrainReservation) {
  return constructWin32Wait(handle, reservation)
}
function constructWin32Wait(handle: NativePtr, reservation: WaitDrainReservation, prepared?: ReturnType<typeof bindNativeWait>) {
  let ptr: ReturnType<typeof koffi.pointer> | undefined
  let trampoline: ReturnType<typeof koffi.register> | undefined
  let slot: ReturnType<typeof koffi.alloc> | undefined
  let registrationFailed = false
  let registrationFailure: unknown
  let nativeRegistered = false
  let issueUnknown = false
  const wait = createRegisteredWait<NativePtr | undefined>({
    register(callback) {
      try {
        const native = prepared ?? bindNativeWait()
        ptr = native.ptr
        const { register, lastError } = native
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
        registrationFailed = true
        registrationFailure = error
        return undefined
      }
    },
    // If decoding failed after successful registration, retry decoding the retained
    // out-slot. Never interpret that exception as evidence of no native wait.
    unregister: registration => {
      if (!nativeRegistered && !issueUnknown) return Promise.resolve(0)
      let address: NativePtr
      try { address = registration ?? koffi.decode(slot!, ptr!) as NativePtr } catch (error) {
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
  const setup = registrationFailed ? Promise.reject(registrationFailure) : Promise.resolve()
  void setup.catch(() => {})
  return {
    setup,
    signalled: registrationFailed ? Promise.reject(registrationFailure) : wait.signalled,
    close() {
      return wait.close().catch(cleanup => {
        if (registrationFailed) throw new AggregateError([registrationFailure, cleanup], 'wait construction failed and original cleanup remains incomplete', { cause: registrationFailure })
        throw cleanup
      })
    },
  } as const
}


