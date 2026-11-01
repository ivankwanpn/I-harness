import { randomUUID } from 'node:crypto'
import koffi from 'koffi'
import { isInvalidHandle, isNullPtr, type NativePtr } from './ffi.ts'
import { Win32Error } from './errors.ts'
import { createReadOwner } from './overlapped-read.ts'
import { registerWin32Wait } from './win32-wait.ts'
import { WaitDrainTransportError, type WaitDrainService } from './native-wait-bridge.ts'

type Observer = { signalled: Promise<void>; close(): Promise<void> }
/** Original synchronous Win32 calls and native-memory operations. Injection is for causal tests only. */
export interface Win32PipeApi {
  alloc(size: number): NativePtr
  free(pointer: NativePtr): void
  zero(pointer: NativePtr, size: number): void
  pointer(pointer: NativePtr, offset: number, value: NativePtr): void
  uint32(pointer: NativePtr): number
  decodePointer(pointer: NativePtr): NativePtr
  bytes(pointer: NativePtr, count: number): Buffer
  securityAttributes(pointer: NativePtr, descriptor: NativePtr): void
  convertSecurity(sddl: string, slot: NativePtr): number
  localFree(pointer: NativePtr): NativePtr | null
  createEvent(): NativePtr
  createNamedPipe(name: string, flags: number, mode: number, instances: number, attributes: NativePtr): NativePtr
  openClient(name: string, access: number): NativePtr
  clientPid(handle: NativePtr, slot: NativePtr): number
  connect(handle: NativePtr, overlapped: NativePtr): number
  read(handle: NativePtr, buffer: NativePtr, capacity: number, count: NativePtr, overlapped: NativePtr): number
  result(handle: NativePtr, overlapped: NativePtr, count: NativePtr): number
  cancel(handle: NativePtr, overlapped: NativePtr): number
  reset(event: NativePtr): number
  close(handle: NativePtr): number
  lastError(): number
  observe(event: NativePtr): Observer
}

/** No DLL/native execution occurs until this adapter is explicitly requested. */
export function win32PipeApi(service: Pick<WaitDrainService, 'reserve'>): Win32PipeApi {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('ACL output pipes require Windows x64')
  const kernel = koffi.load('kernel32.dll')
  const advapi = koffi.load('advapi32.dll')
  const bind = (name: string, result: string, args: string[]) => kernel.func('__stdcall', name, result, args)
  const convert = advapi.func('__stdcall', 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', ['str16', 'uint32', 'void *', 'void *'])
  const createEvent = bind('CreateEventW', 'void *', ['void *', 'int', 'int', 'str16'])
  const createPipe = bind('CreateNamedPipeW', 'void *', ['str16', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', 'void *'])
  const open = bind('CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *'])
  const getPid = bind('GetNamedPipeClientProcessId', 'int', ['void *', 'void *'])
  const connect = bind('ConnectNamedPipe', 'int', ['void *', 'void *'])
  const read = bind('ReadFile', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *'])
  const result = bind('GetOverlappedResult', 'int', ['void *', 'void *', 'void *', 'int'])
  const cancel = bind('CancelIoEx', 'int', ['void *', 'void *'])
  const reset = bind('ResetEvent', 'int', ['void *'])
  const close = bind('CloseHandle', 'int', ['void *'])
  const localFree = bind('LocalFree', 'void *', ['void *'])
  const lastError = bind('GetLastError', 'uint32', [])
  return {
    alloc: size => koffi.alloc('uint8', size) as NativePtr,
    free: pointer => koffi.free(pointer),
    zero: (pointer, size) => koffi.encode(pointer, koffi.array('uint8', size), Array(size).fill(0)),
    pointer: (pointer, offset, value) => koffi.encode(pointer, offset, 'void *', value),
    uint32: pointer => koffi.decode(pointer, 'uint32') as number,
    decodePointer: pointer => koffi.decode(pointer, 'void *') as NativePtr,
    bytes: (pointer, count) => Buffer.from(koffi.decode(pointer, 'uint8', count) as number[]),
    securityAttributes(pointer, descriptor) {
      // SECURITY_ATTRIBUTES x64: DWORD nLength@0, pointer@8, BOOL inherit@16.
      koffi.encode(pointer, 'uint32', 24)
      koffi.encode(pointer, 8, 'void *', descriptor)
    },
    convertSecurity: (sddl, slot) => convert(sddl, 1, slot, null) as number,
    localFree: pointer => localFree(pointer) as NativePtr | null,
    createEvent: () => createEvent(null, 1, 0, null) as NativePtr,
    createNamedPipe: (name, flags, mode, instances, attributes) => createPipe(name, flags, mode, instances, 65536, 65536, 0, attributes) as NativePtr,
    // Neither endpoint is inheritable here. Launch must whitelist an inheritable writer duplicate.
    openClient: (name, access) => open(name, access, 0, null, 3, 0, null) as NativePtr,
    clientPid: (handle, slot) => getPid(handle, slot) as number,
    connect: (handle, overlapped) => connect(handle, overlapped) as number,
    read: (handle, buffer, capacity, count, overlapped) => read(handle, buffer, capacity, count, overlapped) as number,
    result: (handle, overlapped, count) => result(handle, overlapped, count, 0) as number,
    cancel: (handle, overlapped) => cancel(handle, overlapped) as number,
    reset: event => reset(event) as number,
    close: handle => close(handle) as number,
    lastError: () => lastError() as number,
    observe: event => registerWin32Wait(event, service),
  }
}

/**
 * Construct synchronously, register this object with the sandbox, then initialize.
 * Even failed initialization retains its complete partial ledger for cleanup retry.
 * The logon SID is the trusted host token's extracted session SID, never child input.
 */
export function createWin32OutputPipe(logonSid: string, api: Win32PipeApi, capacity = 65536) {
  if (!/^S-1-5-5-\d+-\d+$/.test(logonSid)) throw new Error('host logon SID required')
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65536) throw new Error('invalid native read capacity')
  type Entry = { kind: 'writer' | 'read'; release(): void; done: boolean }
  const ledger: Entry[] = []
  let server!: NativePtr, event!: NativePtr, buffer!: NativePtr, overlapped!: NativePtr, count!: NativePtr
  let writerHandle: NativePtr | undefined
  let writerEntry: Entry | undefined
  let initialization: Promise<void> | undefined
  let reader: ReturnType<typeof createReadOwner> | undefined
  let connectPending = false
  let connectUnknown = false
  let connectWait: Observer | undefined
  let connected = false
  let stopped = false
  let cleanupAttempt: Promise<void> | undefined
  let readAttempt: Promise<Buffer> | undefined
  function failure(name: string, code = api.lastError()): never { throw new Win32Error(name, code) }
  function own(release: () => void, kind: Entry['kind'] = 'read') {
    const entry = { kind, release, done: false }; ledger.push(entry); return entry
  }
  function allocation(size: number) {
    const p = api.alloc(size)
    if (isNullPtr(p)) throw new Error('native allocation failed')
    own(() => api.free(p))
    api.zero(p, size)
    return p
  }
  function handle(acquire: () => NativePtr, label: string, kind: Entry['kind'] = 'read') {
    let value: NativePtr | undefined
    const entry = own(() => {
      if (value === undefined) throw new WaitDrainTransportError('unknown', `${label} acquisition outcome unknown`)
      if (!api.close(value)) failure(`CloseHandle(${label})`)
    }, kind)
    value = acquire()
    if (isInvalidHandle(value)) { entry.done = true; failure(label) }
    if (kind === 'writer') writerEntry = entry
    return value
  }
  function retire(entry: Entry) { if (!entry.done) { entry.release(); entry.done = true } }
  function releaseLedger(includeWriter: boolean) {
    for (const entry of [...ledger].reverse()) if (includeWriter || entry.kind !== 'writer') retire(entry)
  }
  function prepare() {
    if (!api.reset(event)) failure('ResetEvent')
    api.zero(overlapped, 32)
    api.pointer(overlapped, 24, event)
  }
  function cancelOperation() {
    if (!api.cancel(server, overlapped)) {
      const code = api.lastError()
      if (code !== 1168) failure('CancelIoEx', code)
    }
  }
  async function settleConnect() {
    if (connectPending) {
      connectWait ??= api.observe(event)
      try { await connectWait.signalled } catch (error) {
        // Registration failure is not connect completion. Retire its partial
        // callback owner before installing another wait on the original event.
        try { await connectWait.close(); connectWait = undefined } catch { /* retained debt */ }
        throw error
      }
      if (!api.result(server, overlapped, count)) {
        const code = api.lastError()
        if (code === 996) failure('GetOverlappedResult(connect)', code) // Still owns pending I/O.
        connectPending = false // Every other result acknowledges terminal I/O, including errors.
        failure('GetOverlappedResult(connect)', code)
      }
      connectPending = false
    }
    if (connectWait) { await connectWait.close(); connectWait = undefined }
  }
  function outcome(ok: number, name: string) {
    if (!ok) {
      const code = api.lastError()
      if (code === 109 || code === 232) return { kind: 'eof' as const }
      if (code === 995) return { kind: 'aborted' as const, error: new Win32Error(name, code) }
      if (name === 'ReadFile' && code === 997) return { kind: 'pending' as const }
      if (code === 996 && name === 'GetOverlappedResult') failure(name, code)
      return { kind: 'error' as const, error: new Win32Error(name, code) }
    }
    const length = api.uint32(count)
    if (length > capacity) return { kind: 'error' as const, error: new Error('native read exceeds allocation') }
    return { kind: 'data' as const, bytes: api.bytes(buffer, length) }
  }
  function initialize(): Promise<void> {
    if (initialization) return initialization
    if (stopped) return Promise.reject(new Error('pipe owner stopped'))
    initialization = (async () => {
      const descriptorSlot = allocation(8)
      let conversion: 'unknown' | 'success' | 'failed' = 'unknown'
      let descriptor: NativePtr | undefined
      // Install out-slot ownership before conversion. Success can allocate a
      // descriptor even if subsequent pointer decoding throws; retry decoding
      // during cleanup and never free the slot ahead of the descriptor.
      own(() => {
        if (conversion === 'failed') return
        descriptor ??= api.decodePointer(descriptorSlot)
        if (isNullPtr(descriptor)) throw new Error('null converted pipe security descriptor')
        if (!isNullPtr(api.localFree(descriptor))) failure('LocalFree(pipe security)')
      })
      if (!api.convertSecurity(`D:P(A;;0x0012019f;;;${logonSid})`, descriptorSlot)) { conversion = 'failed'; failure('ConvertStringSecurityDescriptorToSecurityDescriptorW') }
      conversion = 'success'
      descriptor = api.decodePointer(descriptorSlot)
      if (isNullPtr(descriptor)) throw new Error('null pipe security descriptor')
      const attributes = allocation(24)
      api.securityAttributes(attributes, descriptor)
      buffer = allocation(capacity)
      overlapped = allocation(32)
      count = allocation(4)
      const pidSlot = allocation(4)
      event = handle(() => api.createEvent(), 'CreateEventW')
      const name = `\\\\.\\pipe\\ih-acl-${randomUUID()}`
      server = handle(() => api.createNamedPipe(name, 0x40080001, 8, 1, attributes), 'CreateNamedPipeW')
      writerHandle = handle(() => api.openClient(name, 0x100002), 'CreateFileW', 'writer')
      prepare()
      let connectResult: number
      try { connectResult = api.connect(server, overlapped) } catch (error) { connectUnknown = true; throw error }
      if (!connectResult) {
        const code = api.lastError()
        if (code === 997) { connectPending = true; await settleConnect() }
        else if (code !== 535) failure('ConnectNamedPipe', code)
      }
      if (!api.clientPid(server, pidSlot)) failure('GetNamedPipeClientProcessId')
      if (api.uint32(pidSlot) !== process.pid) throw new Error('named pipe peer is not host PID')
      connected = true
      reader = createReadOwner({
        submit() {
          prepare()
          let result: number
          try { result = api.read(server, buffer, capacity, count, overlapped) } catch (error) { return { kind: 'unknown', error } }
          return outcome(result, 'ReadFile')
        },
        observe: () => api.observe(event),
        result() {
          const value = outcome(api.result(server, overlapped, count), 'GetOverlappedResult')
          if (value.kind === 'pending') throw new Error('unexpected pending result')
          return value
        },
        cancel: cancelOperation,
        release: () => releaseLedger(false),
      })
    })()
    // A rejected initialization is retained, never replaced with another set of native resources.
    return initialization
  }
  function readAll() {
    readAttempt ??= (async () => { await initialize(); if (stopped) throw new Error('pipe owner stopped'); return reader!.readAll() })()
    return readAttempt
  }
  function cleanup(): Promise<void> {
    if (cleanupAttempt) return cleanupAttempt
    stopped = true
    const attempt = (async () => {
      if (connectPending) cancelOperation()
      if (initialization) await initialization.catch(() => {})
      if (connectUnknown) throw new WaitDrainTransportError('unknown', 'connect submission outcome unknown; native storage remains owned')
      if (connectPending || connectWait) await settleConnect()
      if (reader) await reader.cancel()
      releaseLedger(true)
    })()
    cleanupAttempt = attempt
    void attempt.finally(() => { if (cleanupAttempt === attempt) cleanupAttempt = undefined }).catch(() => {})
    return attempt
  }
  return {
    initialize, readAll, cleanup, cancel: cleanup,
    writer() { if (!connected || stopped || writerEntry?.done) throw new Error('pipe writer unavailable'); return writerHandle! },
    async closeWriter() { if (writerEntry) retire(writerEntry) },
  }
}
