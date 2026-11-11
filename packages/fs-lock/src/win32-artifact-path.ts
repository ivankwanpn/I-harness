import { win32 as path } from 'node:path'
import { types } from 'node:util'
import { win32ArtifactApi, type Win32ArtifactApi } from './win32-artifact-api.ts'

type Directory = Readonly<{ volume: string; id: string; sensitive: boolean; final: string }>
type Evidence = Readonly<{ path: string; directory: Directory }>
type Snapshot = { kind: 'ready'; key: string; evidence: Evidence[] } | { kind: 'needs-parents' | 'needs-root'; evidence: Evidence[] }
export type Win32ArtifactPathCapture = Readonly<{ kind: 'ready'; key: string; assertCurrent(): void } | { kind: 'needs-parents'; assertCurrent(): void } | { kind: 'needs-root'; preparation: Readonly<{ kind: 'root-only'; path: string }>; assertCurrent(): void }>
type Handle = { value?: bigint; unknown: boolean; closed?: boolean; cause?: unknown }
type CurrentCheck = Readonly<{ capture: object; method: () => void }>
const nativeChecks = new WeakMap<object, { method: () => void; retire(): void }>()
type Sample = { value: Directory; verify(): void }
type Samples = [Map<string, Sample>, Map<string, Sample>]
let validationSamples: Map<Win32ArtifactApi, Samples> | undefined
/** Called only by the existing synchronous original-guard flush. Unknown
 * callbacks divide intervals; neither directory samples nor success escape it. */
export function checkWin32ArtifactPaths(checks: readonly CurrentCheck[]): void {
  const outer = validationSamples
  validationSamples = undefined
  try {
    if (types.isProxy(checks) || !Array.isArray(checks)) throw TypeError('Original artifact checks required')
    const copied: CurrentCheck[] = []
    for (let index = 0; index < checks.length; index++) {
      const field = Object.getOwnPropertyDescriptor(checks, index)
      if (!field || !('value' in field) || !field.value || types.isProxy(field.value)) throw TypeError('Original artifact checks required')
      const fields = Object.getOwnPropertyDescriptors(field.value)
      if (!fields.capture || !('value' in fields.capture) || !fields.method || !('value' in fields.method)) throw TypeError('Original artifact checks required')
      copied.push({ capture: fields.capture.value, method: fields.method.value })
    }
    validationSamples = new Map()
    let participating: { retire(): void }[] = []
    const finish = () => {
      const samples = validationSamples
      validationSamples = undefined
      try {
        // Bracket every leaf sample: roots sampled by an earlier capture must
        // still name the same directory after the last capture has completed.
        if (samples) for (const pair of samples.values()) {
          const paths = new Map([...pair[0], ...pair[1]])
          for (const sample of paths.values()) sample.verify()
        }
      } catch (failure) { for (const check of participating) check.retire(); throw failure }
      participating = []
    }
    for (const { capture, method } of copied) {
      const assertMethod = () => {
        const field = Object.getOwnPropertyDescriptor(capture, 'assertCurrent')
        if (!field || !('value' in field) || field.value !== method) throw TypeError('Changed original artifact assertion')
      }
      const native = nativeChecks.get(capture)
      if (native?.method === method) { participating.push(native); assertMethod(); Reflect.apply(method, capture, []) }
      else {
        finish()
        try { assertMethod(); Reflect.apply(method, capture, []) } finally { validationSamples = new Map() }
      }
    }
    finish()
  } finally { validationSamples = outer }
}
const MAX_UNITS = 32_768
class NativeIdentityError extends Error {
  constructor(readonly operation: string, readonly code: number) { super(`${operation} failed (Win32 ${code})`); this.name = 'NativeIdentityError' }
}
const same = (a: Directory, b: Directory) => a.volume === b.volume && a.id === b.id && a.sensitive === b.sensitive && a.final === b.final
const sameEvidence = (a: readonly Evidence[], b: readonly Evidence[]) => a.length === b.length && a.every((item, index) => item.path === b[index]!.path && same(item.directory, b[index]!.directory))
function absolute(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.length > MAX_UNITS) throw new TypeError('Invalid original artifact path')
  return path.normalize(value)
}

export function createWin32ArtifactPathOwner(root: string) {
  return createOwner(root, win32ArtifactApi(), true)
}

/** Internal injected boundary. Production construction uses the original DLL owner. */
export function createWin32ArtifactPathOwnerWithApi(root: string, input: Win32ArtifactApi) {
  return createOwner(root, input, false)
}
function createOwner(root: string, input: Win32ArtifactApi, native: boolean) {
  root = absolute(root)
  const names = ['createFileW', 'getFileInformationByHandleEx', 'getFinalPathNameByHandleW', 'lcMapStringEx', 'closeHandle', 'getLastError'] as const
  const api = Object.fromEntries(names.map(name => [name, input[name].bind(input)])) as unknown as Win32ArtifactApi
  const handles = new Set<Handle>()
  let busy = false, boundRoot: Directory | undefined
  const nativeError = (operation: string) => new NativeIdentityError(operation, api.getLastError())
  const bool = (result: number, operation: string) => {
    if (!Number.isInteger(result) || result < -0x80000000 || result > 0x7fffffff) throw new Error(`${operation} returned invalid BOOL`)
    if (result === 0) throw nativeError(operation)
  }
  function close(handle: Handle) {
    if (handle.closed) { handles.delete(handle); return }
    if (handle.unknown) throw handle.cause
    if (handle.value === undefined) throw new Error('Original native open is unresolved')
    let result: number
    try { result = api.closeHandle(handle.value) }
    catch (cause) { handle.unknown = true; handle.cause = cause; throw cause }
    if (result === 0) { const failure = nativeError('CloseHandle'); handle.cause = failure; throw failure }
    if (!Number.isInteger(result) || result < -0x80000000 || result > 0x7fffffff) {
      handle.unknown = true; handle.cause = new Error('CloseHandle returned invalid BOOL'); throw handle.cause
    }
    handle.closed = true
    handles.delete(handle)
  }
  function settle() {
    const failures: unknown[] = []
    for (const handle of handles) try { close(handle) } catch (cause) { failures.push(cause) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Artifact identity cleanup unresolved')
  }
  function open(name: string): Handle {
    const handle: Handle = { unknown: false }
    handles.add(handle)
    let value: bigint | null
    try { value = api.createFileW(name, 0x80, 7, null, 3, 0x02200000, null) }
    catch (cause) { handle.unknown = true; handle.cause = cause; throw cause }
    if (value === null || value === 0n || value === -1n || value === 0xffffffffn || value === 0xffffffffffffffffn) {
      handles.delete(handle); throw nativeError('CreateFileW')
    }
    if (typeof value !== 'bigint' || value <= 0n || value >= 0xffffffffffffffffn) {
      handle.unknown = true; handle.cause = new Error('CreateFileW returned invalid handle'); throw handle.cause
    }
    handle.value = value
    return handle
  }
  function information(handle: bigint, kind: number, size: number): Buffer {
    const output = Buffer.alloc(size)
    bool(api.getFileInformationByHandleEx(handle, kind, output, size), 'GetFileInformationByHandleEx')
    return output
  }
  function finalPath(handle: bigint): string {
    let size = 256
    for (let attempt = 0; attempt < 3; attempt++) {
      const output = Buffer.alloc(size * 2)
      const count = api.getFinalPathNameByHandleW(handle, output, size, 2)
      if (count === 0) throw nativeError('GetFinalPathNameByHandleW')
      if (!Number.isSafeInteger(count) || count < 1 || count > MAX_UNITS) throw new Error('Invalid normalized path length')
      if (count >= size) { size = count; continue }
      const result = output.toString('utf16le', 0, count * 2)
      if (result.includes('\0') || output.readUInt16LE(count * 2) !== 0) throw new Error('Invalid normalized path data')
      return result
    }
    throw new Error('Normalized native path kept changing')
  }
  function details(handle: bigint): Directory {
    const attributes = information(handle, 9, 8).readUInt32LE(0)
    if (!(attributes & 0x10) || attributes & 0x400) throw new Error('Artifact ancestor is not an original non-reparse directory')
    const identity = information(handle, 18, 24), flags = information(handle, 23, 4).readUInt32LE(0)
    if (flags & ~1) throw new Error('Unknown directory case policy')
    return Object.freeze({ volume: identity.subarray(0, 8).toString('hex'), id: identity.subarray(8, 24).toString('hex'), sensitive: flags === 1, final: finalPath(handle) })
  }
  let pass: 0 | 1 | undefined
  let finalSample = false
  function directory(name: string, rootCapture = false): Directory {
    let samples: Map<string, Sample> | undefined
    if (native && pass !== undefined && validationSamples) {
      let pair = validationSamples.get(input)
      if (!pair) { pair = [new Map(), new Map()]; validationSamples.set(input, pair) }
      samples = pair[pass]
      const saved = samples.get(name)
      if (saved) {
        if (rootCapture) { if (boundRoot && !same(boundRoot, saved.value)) throw Error('Original artifact root changed'); boundRoot ??= saved.value }
        return saved.value
      }
    }
    const handle = open(name)
    let result: Directory | undefined, failed = false, failure: unknown
    try {
      result = details(handle.value!)
      // An enrolled currentness batch compares two independently opened full
      // samples with its existing expected identity. Initial captures and
      // injected APIs retain their additional same-handle observation.
      if (!samples && !finalSample && !same(result, details(handle.value!))) throw new Error('Artifact directory changed during capture')
      if (rootCapture) {
        if (boundRoot && !same(boundRoot, result)) throw new Error('Original artifact root changed')
        boundRoot ??= result
      }
    } catch (cause) { failed = true; failure = cause }
    try { close(handle) }
    catch (cleanup) { if (failed) throw new AggregateError([failure, cleanup], 'Directory capture and cleanup failed', { cause: failure }); throw cleanup }
    if (failed) throw failure
    if (samples) {
      const value = result!
      samples.set(name, { value, verify() {
        finalSample = true
        try { if (!same(value, directory(name, rootCapture))) throw Error('Original artifact path changed') }
        finally { finalSample = false }
      } })
    }
    return result!
  }
  function fold(leaf: string): string {
    const count = api.lcMapStringEx('', 0x200, leaf, leaf.length, null, 0, null, null, 0n)
    if (count === 0) throw nativeError('LCMapStringEx')
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_UNITS) throw new Error('Invalid native case-map length')
    const output = Buffer.alloc(count * 2)
    const written = api.lcMapStringEx('', 0x200, leaf, leaf.length, output, count, null, null, 0n)
    if (written === 0) throw nativeError('LCMapStringEx')
    if (written !== count) throw new Error('Native case-map result changed')
    const result = output.toString('utf16le')
    if (result.includes('\0')) throw new Error('Invalid native case-map data')
    return result
  }
  function snapshot(target: string, readyKey?: string): Snapshot {
    const evidence: Evidence[] = []
    let missingAllowed = boundRoot === undefined
    const parts = (value: string) => value.slice(path.parse(value).root.length).split('\\').filter(Boolean)
    const rootParts = parts(root), parent = path.dirname(target), parentParts = parts(parent)
    if (parentParts.length < rootParts.length || target === root) throw new Error('Artifact outside original root')
    try {
      const original = directory(root, true)
      evidence.push(Object.freeze({ path: root, directory: original }))
      missingAllowed = false
      // Check actual root spelling by identity; win32.relative's case folding
      // cannot certify containment in a case-sensitive containing directory.
      const candidate = path.join(path.parse(parent).root, ...parentParts.slice(0, rootParts.length))
      if (candidate !== root) {
        const reached = directory(candidate)
        if (!same(reached, original)) throw new Error('Artifact reaches another root')
        evidence.push(Object.freeze({ path: candidate, directory: reached }))
      }
      missingAllowed = true
      let containing = original
      for (let index = rootParts.length + 1; index <= parentParts.length; index++) {
        const current = path.join(path.parse(parent).root, ...parentParts.slice(0, index))
        containing = directory(current)
        evidence.push(Object.freeze({ path: current, directory: containing }))
      }
      // For an original native currentness check, basename is constructor-owned
      // and immutable. Directory ID, case policy and final spelling are still
      // sampled and compared; their matching evidence implies the same key.
      if (readyKey !== undefined) return { kind: 'ready', key: readyKey, evidence }
      const leaf = path.basename(target), encoded = Buffer.from(containing.sensitive ? leaf : fold(leaf), 'utf16le')
      return { kind: 'ready', key: `artifact-dir-v1:${containing.volume}:${containing.id}:${containing.sensitive ? 'S' : 'I'}:${encoded.length}:${encoded.toString('hex')}`, evidence }
    } catch (cause) {
      if (missingAllowed && cause instanceof NativeIdentityError && cause.operation === 'CreateFileW' && (cause.code === 2 || cause.code === 3)) {
        if (boundRoot === undefined && evidence.length === 0) {
          // An absent constructor root grants no target-parent authority. Capture
          // only original-spelling existing ancestors for root-only preparation.
          for (let count = 0; count < rootParts.length; count++) {
            const ancestor = path.join(path.parse(root).root, ...rootParts.slice(0, count))
            try { evidence.push(Object.freeze({ path: ancestor, directory: directory(ancestor) })) }
            catch (error) {
              if (count > 0 && error instanceof NativeIdentityError && error.operation === 'CreateFileW' && (error.code === 2 || error.code === 3)) break
              throw error
            }
          }
          if (!evidence.length) throw new Error('No original root preparation ancestor proved')
          return { kind: 'needs-root', evidence }
        }
        return { kind: 'needs-parents', evidence }
      }
      throw cause
    }
  }
  function captureSnapshot(target: string, readyKey?: string): Snapshot {
    if (busy || handles.size) throw new Error('Artifact identity has active or unresolved native work')
    busy = true
    try {
      pass = 0
      const before = snapshot(target, readyKey)
      pass = 1
      const after = snapshot(target, readyKey)
      if (before.kind !== after.kind || !sameEvidence(before.evidence, after.evidence) || before.kind === 'ready' && (after.kind !== 'ready' || before.key !== after.key)) throw new Error('Artifact path changed during capture')
      return before
    } finally { pass = undefined; busy = false }
  }
  const owner = Object.freeze({
    capture(target: string): Win32ArtifactPathCapture {
      if (this !== owner) throw new TypeError('Invalid artifact path owner receiver')
      target = absolute(target)
      const original = captureSnapshot(target)
      let retired = false
      let result: Win32ArtifactPathCapture
      function assertCurrent(this: Win32ArtifactPathCapture) {
        if (this !== result || retired) throw new Error('Artifact path capture unavailable')
        try {
          const current = captureSnapshot(target, native && original.kind === 'ready' ? original.key : undefined)
          if (current.kind !== original.kind || !sameEvidence(current.evidence, original.evidence) || original.kind === 'ready' && (current.kind !== 'ready' || original.key !== current.key)) throw new Error('Original artifact path changed')
        } catch (cause) { retired = true; throw cause }
      }
      result = original.kind === 'ready'
        ? Object.freeze({ kind: 'ready' as const, key: original.key, assertCurrent })
        : original.kind === 'needs-root'
          ? Object.freeze({ kind: 'needs-root' as const, preparation: Object.freeze({ kind: 'root-only' as const, path: root }), assertCurrent })
          : Object.freeze({ kind: 'needs-parents' as const, assertCurrent })
      if (native) nativeChecks.set(result, { method: assertCurrent, retire() { retired = true } })
      return result
    },
    settleResources() {
      if (this !== owner || busy) throw new TypeError('Artifact identity cleanup reentry')
      busy = true
      try { settle() } finally { busy = false }
    },
  })
  return owner
}
