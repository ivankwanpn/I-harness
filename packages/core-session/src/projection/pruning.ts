import type { Session } from "../events/types.ts"

// M33: one pruned tool/result — the stringified output is narrowed on the
// projection surface to `head` + a placeholder + `tail` (`removedBytes` is the
// byte count of the middle that was cut). This record is what
// `compaction/prune` events carry; the projection alone applies it.
export interface PruneRecord {
  callId: string
  head: string
  tail: string
  removedBytes: number
}

/** The projection-side substitute for a pruned tool/result. */
export function renderPruneSubstitute(record: PruneRecord): string {
  return `${record.head}\n…(pruned ${record.removedBytes} bytes)…\n${record.tail}`
}

// M33: fold EVERY compaction/prune event into callId → record (last wins per
// callId — later prune passes may re-plan an earlier pass's callId). The map
// drives deriveMessages' tool/result projection AND the compaction engine's
// summary-input render; the durable log is never rewritten.
export function derivePruneSubstitutes(session: Session): Map<string, PruneRecord> {
  const map = new Map<string, PruneRecord>()
  for (const ev of session.events) {
    if (ev.type !== "compaction/prune") continue
    // defensive `?? []`: persisted logs bypass append validation (fromJSONL
    // does not validate), so a malformed marker must not throw here
    for (const record of ev.pruned ?? []) map.set(record.callId, record)
  }
  return map
}
