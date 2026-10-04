import type { DatabaseSync } from 'node:sqlite'
import { checkAbort } from './bytes.ts'
import type { ContextResultRef } from './types.ts'

const PAGE_ROWS = 64
const MAX_INDEX_ROWS = 1024
const MAX_CANDIDATES = 256
const MAX_FALLBACK_REFS = 128

export async function* walkCandidates(
  db: DatabaseSync, lookup: (id: string) => ContextResultRef|undefined,
  terms: string[], signal: AbortSignal, mark: (reason: string) => void,
): AsyncGenerator<{ ref: ContextResultRef; verify: boolean }> {
  const seen = new Set<string>()
  const anchors = terms.filter((term) => [...term].length >= 3)
  const yieldTurn = async () => { await new Promise((settle) => setImmediate(settle)); checkAbort(signal) }
  if (anchors.length) {
    // Quoted trigram MATCH anchors preserve substring/CJK retrieval. Exact
    // matching is checked against the immutable text after host authorization.
    const expression = anchors.map((term) => `"${term.toLowerCase().replaceAll('"', '""')}"`).join(' OR ')
    const statement = db.prepare('SELECT rowid,ref_id FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid>? LIMIT ?')
    let cursor = 0
    let visited = 0
    while (visited < MAX_INDEX_ROWS && seen.size < MAX_CANDIDATES) {
      await yieldTurn()
      const rows = statement.all(expression, cursor, Math.min(PAGE_ROWS, MAX_INDEX_ROWS - visited))
      if (!rows.length) break
      for (const row of rows) {
        checkAbort(signal)
        cursor = Number(row.rowid)
        visited++
        const id = String(row.ref_id)
        if (seen.has(id)) continue
        const ref = lookup(id)
        if (!ref) continue
        seen.add(id)
        yield { ref, verify: true }
        if (seen.size >= MAX_CANDIDATES) break
      }
      if (rows.length < PAGE_ROWS) break
    }
    if (visited >= MAX_INDEX_ROWS || seen.size >= MAX_CANDIDATES) mark('candidate-budget')
  } else {
    // Trigram FTS cannot index fewer than three Unicode characters. Scan a
    // bounded set of ref IDs via the expiry index, and label this fallback.
    mark('short-query-fallback')
    await yieldTurn()
    const rows = db.prepare('SELECT id FROM refs WHERE expires_at>? LIMIT ?').all(Date.now(), MAX_FALLBACK_REFS + 1)
    if (rows.length > MAX_FALLBACK_REFS) mark('candidate-budget')
    for (const row of rows.slice(0, MAX_FALLBACK_REFS)) {
      checkAbort(signal)
      const ref = lookup(String(row.id))
      if (ref) { seen.add(ref.id); yield { ref, verify: true } }
    }
  }
  // Audit incomplete refs separately, without loading their blobs just to
  // label a missing suffix. This metadata walk is also indexed and bounded.
  await yieldTurn()
  const partial = db.prepare('SELECT id FROM refs WHERE complete=0 AND expires_at>? LIMIT ?').all(Date.now(), MAX_FALLBACK_REFS + 1)
  if (partial.length > MAX_FALLBACK_REFS) mark('candidate-budget')
  for (const row of partial.slice(0, MAX_FALLBACK_REFS)) {
    checkAbort(signal)
    const id = String(row.id)
    if (seen.has(id)) continue
    const ref = lookup(id)
    if (ref) yield { ref, verify: false }
  }
}
