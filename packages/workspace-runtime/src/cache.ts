import { randomUUID } from "node:crypto"
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, parse, relative, resolve, sep } from "node:path"
import { setImmediate } from "node:timers/promises"
import { acquireSessionLock, SessionLockConflictError } from "@i-harness/fs-lock"
import { readNodeArchive } from "./archive.ts"
import { downloadNodeArchive, verifyArchiveDigest } from "./download.ts"
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, NODE_PIN, WRAPPERS } from "./pin.ts"

const POINTER = `current-v${NODE_PIN.version}-linux-${NODE_PIN.architecture}.json`
const releasePattern = /^node-v22\.23\.3-linux-x64-[a-f0-9-]{36}$/
type File = { bytes: Buffer; mode: number }
export function captureCacheRoot(input: string): string {
  const root = resolve(input)
  if (root === parse(root).root) throw new Error("Managed cache must be an IH-owned child directory")
  return root
}
/** Refuse junctions/symlinks in every existing ancestor before reading/writing. */
function directories(path: string, create = false): void {
  const parents: string[] = []
  for (let current = resolve(path);; current = dirname(current)) {
    parents.push(current); if (current === dirname(current)) break
  }
  for (const current of parents.reverse()) {
    try {
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed cache path is not a regular directory")
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
      if (create) mkdirSync(current, { mode: 0o700 })
    }
  }
}
function missing(cause: unknown): boolean { return (cause as NodeJS.ErrnoException).code === "ENOENT" }
function regularMetadata(path: string, limit: number) {
  directories(dirname(path))
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error("Managed cache file is linked, unsafe or exceeds its limit")
  return before
}
function boundedFile(path: string, limit: number): Buffer {
  const before = regularMetadata(path, limit)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const first = fstatSync(fd)
    if (!first.isFile() || first.nlink !== 1 || first.dev !== before.dev || first.ino !== before.ino || first.size > limit) throw new Error("Managed cache file changed before read")
    const bytes = Buffer.alloc(first.size + 1)
    let count = 0
    while (count < bytes.length) { const next = readSync(fd, bytes, count, bytes.length - count, null); if (!next) break; count += next }
    const last = fstatSync(fd), current = lstatSync(path)
    if (count !== first.size || last.size !== first.size || last.mtimeMs !== first.mtimeMs || last.ctimeMs !== first.ctimeMs
      || current.dev !== first.dev || current.ino !== first.ino || current.isSymbolicLink() || current.nlink !== 1) throw new Error("Managed cache file changed during read")
    return bytes.subarray(0, count)
  } finally { closeSync(fd) }
}
function filesFor(bytes: Buffer): ReadonlyMap<string, File> {
  verifyArchiveDigest(bytes)
  return new Map([...readNodeArchive(bytes), ...Object.entries(WRAPPERS).map(([path, bytes]) => [path, { bytes, mode: 0o555 }] as const)])
}
function runtimeIdentity(count: number) { return { schema: 1, nodeVersion: NODE_PIN.version, npmVersion: NODE_PIN.npmVersion, architecture: NODE_PIN.architecture, archiveSha256: NODE_PIN.sha256, files: count } }
function verifyRelease(release: string, files: ReadonlyMap<string, File>): void {
  const manifest = JSON.parse(boundedFile(join(release, "runtime.json"), 2048).toString("utf8"))
  if (JSON.stringify(manifest) !== JSON.stringify(runtimeIdentity(files.size))) throw new Error("Managed runtime manifest identity mismatch")
  const expectedDirs = new Set<string>([""])
  for (const path of files.keys()) {
    for (let directory = dirname(path).replaceAll("\\", "/"); directory !== "."; directory = dirname(directory).replaceAll("\\", "/")) expectedDirs.add(directory)
    const bytes = boundedFile(join(release, ...path.split("/")), files.get(path)!.bytes.length)
    if (!bytes.equals(files.get(path)!.bytes)) throw new Error(`Managed runtime file digest mismatch: ${path}`)
  }
  let count = 0
  function scan(directory: string, prefix = ""): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++count > MAX_ARCHIVE_ENTRIES) throw new Error("Managed cache entry limit exceeded")
      const key = prefix + entry.name, path = join(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error("Managed runtime contains a link")
      if (stat.isDirectory()) {
        if (!expectedDirs.has(key)) throw new Error("Managed runtime contains an unexpected directory")
        scan(path, key + "/")
      } else if (!stat.isFile() || stat.nlink !== 1 || key !== "runtime.json" && !files.has(key)) throw new Error("Managed runtime contains an unexpected or linked file")
    }
  }
  scan(release)
}
function archivePath(root: string): string { return join(root, "archives", NODE_PIN.archiveFile) }
function rootIdentity(root: string) {
  directories(root)
  const stat = lstatSync(root)
  return { dev: stat.dev, ino: stat.ino }
}
function replaceOwnedFile(root: string, identity: { dev: number; ino: number }, temporary: string, target: string): void {
  const currentRoot = rootIdentity(root)
  if (currentRoot.dev !== identity.dev || currentRoot.ino !== identity.ino
    || target !== archivePath(root) && target !== join(root, POINTER)) throw new Error("Managed cache root identity changed before promotion")
  directories(dirname(target))
  let fd: number | undefined
  try {
    let before
    try { before = lstatSync(target) } catch (cause) { if (!missing(cause)) throw cause }
    if (before) {
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("Managed cache replacement target is linked or unsafe")
      fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const captured = fstatSync(fd)
      if (captured.dev !== before.dev || captured.ino !== before.ino || !captured.isFile() || captured.nlink !== 1) throw new Error("Managed cache replacement inode changed")
      // Only this validated IH-owned inode has its readonly attribute cleared.
      // An outside hardlink or a symlink never reaches this operation.
      fchmodSync(fd, 0o600)
      const after = lstatSync(target), held = fstatSync(fd), checkedRoot = rootIdentity(root)
      if (after.dev !== captured.dev || after.ino !== captured.ino || after.isSymbolicLink() || held.nlink !== 1
        || checkedRoot.dev !== identity.dev || checkedRoot.ino !== identity.ino) throw new Error("Managed cache replacement authority changed")
      // Windows refuses replacement while this read handle remains open.
      // Close it after changing only the captured inode, then fence the path
      // again before replacing the owned directory entry.
      closeSync(fd); fd = undefined
      const closed = lstatSync(target)
      if (closed.dev !== captured.dev || closed.ino !== captured.ino || !closed.isFile() || closed.isSymbolicLink() || closed.nlink !== 1) throw new Error("Managed cache replacement path changed after close")
    }
    renameSync(temporary, target)
  } finally { if (fd !== undefined) closeSync(fd) }
}
async function installLock(path: string, signal?: AbortSignal) {
  const deadline = Date.now() + 125_000
  for (;;) {
    signal?.throwIfAborted()
    try {
      // The lock primitive has no signal parameter. Own at most a 250ms
      // acquisition interval; release a late-acquired lease before cancelling.
      const lock = await acquireSessionLock({ lockPath: path, deadlineMs: Math.min(250, Math.max(1, deadline - Date.now())), retryMs: 20, retryMaxMs: 50 })
      if (signal?.aborted) { await lock.release(); signal.throwIfAborted() }
      return lock
    } catch (cause) {
      signal?.throwIfAborted()
      if (!(cause instanceof SessionLockConflictError) || Date.now() >= deadline) throw cause
    }
  }
}

/** Re-derive every expected byte from the pinned compressed artifact each time.
 * A mutable manifest or stale inventory never grants executable authority.
 */
export function verifiedManagedRelease(root: string): string | undefined {
  let pointer: Buffer
  try { pointer = boundedFile(join(root, POINTER), 2048) } catch (cause) { if (missing(cause)) return undefined; throw cause }
  const value = JSON.parse(pointer.toString("utf8")) as { release?: unknown; sha256?: unknown }
  if (typeof value.release !== "string" || !releasePattern.test(value.release) || value.sha256 !== NODE_PIN.sha256) throw new Error("Managed runtime cache pointer is invalid")
  const release = join(root, "releases", value.release)
  verifyRelease(release, filesFor(boundedFile(archivePath(root), MAX_ARCHIVE_BYTES)))
  return release
}
function writeFresh(path: string, bytes: Buffer | string, mode = 0o444): void {
  directories(dirname(path), true)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
}
function replacePointer(root: string, identity: { dev: number; ino: number }, release: string): void {
  const path = join(root, POINTER)
  try { boundedFile(path, 2048) } catch (cause) { if (!missing(cause)) throw cause }
  const temporary = join(root, `.pointer-${randomUUID()}.json`)
  try { writeFresh(temporary, JSON.stringify({ release, sha256: NODE_PIN.sha256 }) + "\n", 0o600); replaceOwnedFile(root, identity, temporary, path) }
  finally { try { rmSync(temporary) } catch (cause) { if (!missing(cause)) throw cause } }
}
function removeStage(root: string, stage: string): void {
  const tail = relative(root, resolve(stage))
  if (!tail || tail === ".." || tail.startsWith(`..${sep}`) || resolve(stage) === parse(resolve(stage)).root) throw new Error("Managed cache cleanup target escaped its owner")
  directories(dirname(stage))
  const stat = lstatSync(stage)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed cache stage changed before cleanup")
  rmSync(stage, { recursive: true, force: true })
}
export async function installManagedRelease(root: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted(); directories(root, true)
  const identity = rootIdentity(root)
  const lockPath = join(root, "install.lock")
  // Another Windows installer owns byte zero with LockFileEx. Metadata may be
  // validated here, but reading that byte would refuse instead of waiting.
  try { regularMetadata(lockPath, 4096) } catch (cause) { if (!missing(cause)) throw cause }
  const lock = await installLock(lockPath, signal)
  let stage: string | undefined
  try {
    signal?.throwIfAborted()
    const acquiredRoot = rootIdentity(root)
    if (acquiredRoot.dev !== identity.dev || acquiredRoot.ino !== identity.ino) throw new Error("Managed cache root changed during lease acquisition")
    try { const existing = verifiedManagedRelease(root); if (existing) return existing }
    catch { /* Explicit repair creates a new release; existing release bytes are untouched. */ }
    // Refuse unsafe pointer paths before any network operation.
    try { boundedFile(join(root, POINTER), 2048) } catch (cause) { if (!missing(cause)) throw cause }
    let bytes: Buffer | undefined
    try { bytes = boundedFile(archivePath(root), MAX_ARCHIVE_BYTES); verifyArchiveDigest(bytes) }
    catch (cause) {
      if (!missing(cause) && !/digest mismatch/.test(cause instanceof Error ? cause.message : "")) throw cause
      bytes = undefined
    }
    if (!bytes) {
      bytes = await downloadNodeArchive(fetcher, signal)
      directories(dirname(archivePath(root)), true)
      const temporary = join(root, "archives", `.download-${randomUUID()}`)
      try { writeFresh(temporary, bytes); replaceOwnedFile(root, identity, temporary, archivePath(root)) }
      finally { try { rmSync(temporary) } catch (cause) { if (!missing(cause)) throw cause } }
    }
    const files = filesFor(bytes)
    directories(join(root, "releases"), true)
    stage = join(root, "releases", `.stage-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 })
    let count = 0
    for (const [path, file] of files) {
      signal?.throwIfAborted()
      writeFresh(join(stage, ...path.split("/")), file.bytes, file.mode)
      if (++count % 64 === 0) await setImmediate()
    }
    writeFresh(join(stage, "runtime.json"), JSON.stringify(runtimeIdentity(files.size)))
    verifyRelease(stage, files)
    signal?.throwIfAborted()
    const name = `${NODE_PIN.archiveRoot}-${randomUUID()}`, release = join(root, "releases", name)
    renameSync(stage, release); stage = undefined
    replacePointer(root, identity, name)
    return release
  } finally {
    try { if (stage) removeStage(root, stage) } finally { await lock.release() }
  }
}
