import { COMMIT_FORMAT_VERSION, GENESIS_PREV, decodeCommit, encodeCommit, type CommitOp, type CommitRecord } from './format.ts'
import { foldCommits, type CommitView } from './fold.ts'

/** The coordinator's document namespace exposes current values and clear
 * tombstones. Its private historical replacements can become one checkpoint
 * after all original readers have released their snapshot leases. */
export function documentCheckpoint(records: readonly CommitRecord[], view: CommitView) {
  if (view.header.kind !== 'document-store') return
  const latest = new Map<string, Extract<CommitOp, { kind: 'doc' | 'doc-clear' }>>()
  let updates = 0
  for (const record of records) {
    if (record.entries.length) return
    for (const op of record.ops) {
      if (op.kind === 'header') continue
      if (op.kind !== 'doc' && op.kind !== 'doc-clear') return
      latest.set(op.key, op)
      updates++
    }
  }
  // Amortize the full checkpoint over obsolete updates. Distinct live keys
  // and durable clear tombstones remain represented exactly once.
  if (updates - latest.size < Math.max(64, latest.size)) return
  const line = encodeCommit({
    v: COMMIT_FORMAT_VERSION,
    seq: 1,
    prev: GENESIS_PREV,
    at: records.at(-1)!.at,
    entries: [],
    ops: [{ kind: 'header', value: view.header }, ...latest.values()],
  }) + '\n'
  const record = decodeCommit(line.slice(0, -1))
  return { line, record, view: foldCommits([record]) }
}
