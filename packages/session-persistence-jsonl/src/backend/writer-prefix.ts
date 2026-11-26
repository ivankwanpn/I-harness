import type { BigIntStats } from 'node:fs'
import { lstat, type FileHandle } from 'node:fs/promises'
import { readFactJournal, validJournalMetadata, type JournalPrefix } from '@i-harness/core-session'
import { RecoveryArchiveMismatch } from '@i-harness/session-persistence/internal/native-fact-writer'
import { parseHeader } from '../format.ts'
import type { BootstrapCaptureIO, CaptureLedger } from './bootstrap-capture-io.ts'

export type CleanWriterPrefix = Readonly<{
  prefix: Readonly<JournalPrefix>
  verify(handle: FileHandle): Promise<boolean | undefined>
  seal(handle: FileHandle): Promise<boolean | undefined>
}>

function changed(repaired = false): never {
  // A completed truncate is a mutation. Its later conflict must keep the
  // coordinator's uncertain recovery state until the file is reconciled.
  if (repaired) throw Error('Managed journal changed after torn-tail recovery')
  throw new RecoveryArchiveMismatch()
}

function sameFile(a: BigIntStats, b: BigIntStats) {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino > 0n && a.ino === b.ino
}

function sameVersion(a: BigIntStats, b: BigIntStats) {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function checkName(path: string, expected: BigIntStats, repaired: boolean) {
  const current = await lstat(path, { bigint: true }).catch(error => {
    if (missing(error)) changed(repaired)
    throw error
  })
  if (!sameVersion(expected, current)) changed(repaired)
}

async function readFixedExtent(handle: FileHandle, extent: bigint, assertHeld: () => void, retained?: Buffer) {
  // Preserve readFile's maximum regular-file size on the ordinary decode.
  if (extent > 0x7fffffffn) throw Object.assign(new RangeError(`File size (${extent}) is greater than 2 GiB`), { code: 'ERR_FS_FILE_TOO_LARGE' })
  const bytes = retained ?? Buffer.allocUnsafe(Number(extent))
  const target = retained ? Buffer.allocUnsafe(Math.min(bytes.length, 65536)) : bytes
  let offset = 0
  while (offset < bytes.length) {
    assertHeld()
    const length = Math.min(65536, bytes.length - offset)
    const { bytesRead } = await handle.read(target, retained ? 0 : offset, length, offset)
    if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) changed(retained !== undefined)
    if (retained && !target.subarray(0, bytesRead).equals(retained.subarray(offset, offset + bytesRead))) changed(true)
    offset += bytesRead
  }
  assertHeld()
  if ((await handle.read(Buffer.allocUnsafe(1), 0, 1, offset)).bytesRead !== 0) changed(retained !== undefined)
  return bytes
}

/** Verify and acknowledge the same tracked r+ descriptor, including recovery
 * of a genuinely torn ordinary tail. A clean observation lends validation
 * only after the writer's own read has matched the whole original file. */
export async function readWriterPrefix(path: string, io: BootstrapCaptureIO, ledger: CaptureLedger,
  assertHeld: () => void, checkAdmission: () => Promise<void>, witness?: CleanWriterPrefix): Promise<JournalPrefix> {
  const before = await lstat(path, { bigint: true }).catch(error => {
    if (witness && missing(error)) changed()
    throw error
  })
  if (!before.isFile() || before.ino <= 0n) changed()
  assertHeld()
  const resource = await io.acquire(ledger, path, 'r+').catch(error => {
    if (missing(error)) changed()
    throw error
  })
  const handle = resource.handle
  let expected = before, repaired = false, primary: { cause: unknown } | undefined
  let prefix: JournalPrefix | undefined
  async function checkDescriptor() {
    assertHeld()
    await checkAdmission()
    if (!sameVersion(expected, await handle.stat({ bigint: true }))) changed(repaired)
    await checkName(path, expected, repaired)
    assertHeld()
  }
  try {
    await checkDescriptor()
    if (witness) {
      const verified = await witness.verify(handle)
      if (verified === false) changed()
      if (verified === true) {
        await checkDescriptor()
        await handle.sync()
        await checkDescriptor()
        const sealed = await witness.seal(handle)
        if (sealed === false) changed()
        if (sealed === true) prefix = { ...witness.prefix }
      }
    }
    if (!prefix) {
      const bytes = await readFixedExtent(handle, before.size, assertHeld)
      await checkDescriptor()
      const end = bytes.indexOf(0x0a), meta = parseHeader(bytes.subarray(0, end).toString('utf8'))
      if (meta.semanticSeed?.version === 3) throw new TypeError('Legacy owned prefix cannot repair selected results')
      if (![6, 7, 8, 9, 10, 11, 12, 13, 14].includes(meta.formatVersion) || !validJournalMetadata(meta.journal)) throw new TypeError('Managed journal format required')
      const decoded = readFactJournal(bytes.subarray(end + 1), meta.journal, meta.formatVersion, meta)
      await checkDescriptor()
      if (decoded.torn) {
        const size = end + 1 + decoded.prefix.bodyBytes
        await handle.truncate(size)
        repaired = true
        expected = await handle.stat({ bigint: true })
        if (!sameFile(before, expected) || expected.size !== BigInt(size)) changed(true)
        await checkDescriptor()
        // Truncation changes the timestamps. Bind the new stamp to the exact
        // header and committed body previously decoded on this descriptor.
        await readFixedExtent(handle, expected.size, assertHeld, bytes.subarray(0, size))
        await checkDescriptor()
      }
      await handle.sync()
      await checkDescriptor()
      prefix = decoded.prefix
    }
  } catch (cause) {
    primary = { cause }
    throw cause
  } finally {
    try { await io.close(ledger, resource) }
    catch (cleanup) {
      if (primary) throw new AggregateError([primary.cause, cleanup], 'Journal prefix read and cleanup failed')
      throw cleanup
    }
  }
  await checkName(path, expected, repaired)
  assertHeld()
  return prefix
}
