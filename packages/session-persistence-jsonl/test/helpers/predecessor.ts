import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import type { PersistenceBackend } from '@i-harness/session-persistence'

/**
 * Create a historical-format session for predecessor/upgrade tests.
 *
 * A new session writer must never mint a downgraded session, so
 * `backend.create` refuses every format except the current one. Tests that
 * need a genuine predecessor file create a current one and rewrite only the
 * header's `formatVersion`: with zero events the header and journal shape are
 * identical for formats 11-14, which is what the predecessor parsers read.
 */
export async function createPredecessorSession(backend: PersistenceBackend, root: string, id: string, formatVersion: number, createdAt = 'x'): Promise<string> {
  if (!Number.isInteger(formatVersion) || formatVersion >= CURRENT_FORMAT_VERSION) throw new TypeError('Predecessor format must predate the current format')
  await backend.create(id, { sessionId: id, formatVersion: CURRENT_FORMAT_VERSION, createdAt })
  const path = join(root, `${id}.jsonl`)
  const lines = (await readFile(path, 'utf8')).split('\n')
  const header = JSON.parse(lines[0]!)
  header.formatVersion = formatVersion
  lines[0] = JSON.stringify(header)
  await writeFile(path, lines.join('\n'))
  return path
}
