import { CommitFormatError } from './errors.ts'
import { GENESIS_PREV, decodeCommit, type CommitRecord } from './format.ts'

const NEWLINE = 0x0a
const utf8 = new TextDecoder('utf-8', { fatal: true })

export type CommitScan = { readonly records: readonly CommitRecord[]; readonly tornBytes: number }

/**
 * Scan raw commit-log bytes into the longest valid prefix. A final line without
 * a newline is a torn tail (ignored and reported); a complete line that fails
 * to decode is corruption and refuses the whole log.
 */
export function scanCommitLog(bytes: Uint8Array): CommitScan {
  const records: CommitRecord[] = []
  let start = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== NEWLINE) continue
    const record = decodeCommit(utf8.decode(bytes.subarray(start, index)))
    const expectedSeq = records.length + 1
    if (record.seq !== expectedSeq) throw new CommitFormatError('chain', `commit seq ${record.seq} does not follow ${expectedSeq - 1}`)
    const expectedPrev = records.length === 0 ? GENESIS_PREV : records[records.length - 1]!.digest
    if (record.prev !== expectedPrev) throw new CommitFormatError('chain', `commit ${record.seq} prev does not match the previous digest`)
    records.push(record)
    start = index + 1
  }
  return { records, tornBytes: bytes.length - start }
}
