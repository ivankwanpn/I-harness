import { decodeUint32, type NativePtr, type Win32Bindings } from './ffi.ts'
import { NativeInitOwner } from './init-owner.ts'
import { createProcessInfoSlot } from './pipe-process-info.ts'
import { acquireChildStdio } from './pipe-stdio.ts'
import { prepareChildStartup } from './startup-attributes.ts'
import { buildCommandLine } from './spawn.ts'
import { Win32Error } from './errors.ts'
import type { PipeChildInput } from './pipe-child.ts'

/** Original launch ledger. Construction performs no native acquisition. Each
 * independently retiring scope has its own finite native-use lifetime. */
export function createPipeChildNative(api: Win32Bindings, token: NativePtr, input: PipeChildInput, assertCurrent: () => void) {
  const launch = new NativeInitOwner(api), stdio = launch.scope(), storage = new NativeInitOwner(api)
  const handles = new NativeInitOwner(api), status = new NativeInitOwner(api)
  let startup: ReturnType<typeof prepareChildStartup> | undefined
  let info: ReturnType<typeof createProcessInfoSlot> | undefined
  let process: NativePtr | undefined, thread: NativePtr | undefined, pid: number | undefined
  let closeThread: (() => void) | undefined, closeProcess: (() => void) | undefined
  let exitCode: number | undefined, exitSlot: NativePtr | undefined
  let termination: 'unissued' | 'acknowledged' | 'unknown' = 'unissued', terminationError: unknown
  function processHandle(): NativePtr {
    if (process === undefined) {
      const value = info!.process() as NativePtr // Validated original HANDLE field.
      process = value
      closeProcess = handles.deferBool('CloseHandle(process)', () => api.closeHandle(value))
    }
    return process
  }
  function threadHandle(): NativePtr {
    if (thread === undefined) {
      const value = info!.thread() as NativePtr
      thread = value
      closeThread = handles.deferBool('CloseHandle(thread)', () => api.closeHandle(value))
    }
    return thread
  }
  return {
    prepare(stdout: NativePtr, stderr: NativePtr) {
      assertCurrent()
      const endpoints = acquireChildStdio(stdio, stdout, stderr)
      startup = prepareChildStartup(launch, endpoints)
      info = createProcessInfoSlot(storage, slot => {
        assertCurrent(); startup!.assertCurrent()
        return api.createProcessAsUserExW(token, null, buildCommandLine(input.command, input.args, input.argumentEncoding), null, null, 1, startup!.creationFlags, null, input.cwd, startup!.startupInfo, slot)
      })
    },
    issue() { info!.issue() },
    phase: () => info?.phase() ?? 'not-issued',
    process: processHandle, thread: threadHandle,
    pid() { return pid ??= info!.pid() },
    async closeLaunch() {
      // Independently decode both handles before any cleanup can expire a guard.
      const errors: unknown[] = []
      if (info?.phase() === 'created' || info?.phase() === 'unknown') {
        try { processHandle() } catch (e) { errors.push(e) }
        try { threadHandle() } catch (e) { errors.push(e) }
        try { pid ??= info.pid() } catch (e) { errors.push(e) }
      }
      if (errors.length) throw new AggregateError(errors, 'original process outputs unresolved')
      startup?.close(); stdio.cleanup(); closeThread?.()
    },
    terminate() {
      if (termination === 'acknowledged') return
      if (termination === 'unknown') throw terminationError
      const handle = processHandle()
      termination = 'unknown'
      try {
        const result = api.terminateProcess(handle, 1)
        if (result === 0) { termination = 'unissued'; throw new Win32Error('TerminateProcess', api.getLastError()) }
        if (!Number.isInteger(result) || result < -0x80000000 || result > 0x7fffffff) throw new Error('TerminateProcess outcome unknown')
        termination = 'acknowledged'
      } catch (e) { terminationError = e; throw e }
    },
    exitCode() {
      if (exitCode !== undefined) return exitCode
      exitSlot ??= status.uint32()
      if (!api.getExitCodeProcess(processHandle(), exitSlot)) throw new Win32Error('GetExitCodeProcess', api.getLastError())
      return exitCode = decodeUint32(exitSlot) // Signalled root permits every DWORD, including 259.
    },
    cleanup() {
      if (info?.phase() === 'unknown') throw new Error('process issue outcome unknown; original storage pinned')
      if (info?.phase() === 'created') {
        // Caller has joined root signal and registration ACK before this method.
        processHandle(); threadHandle(); pid ??= info.pid()
        info.acknowledgeOutputHandoff()
      }
      closeThread?.(); closeProcess?.(); handles.cleanup()
      launch.cleanup(); status.cleanup(); storage.cleanup()
    },
  }
}
