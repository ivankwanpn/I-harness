import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionCoordinator } from '@i-harness/session-persistence'

/** D-07: the task document's in-memory debt is lost on restart. Each save
 * attempt records a durable pending intent first and a settled intent on
 * success; an unmatched pending intent is the durable "write may be unresolved"
 * evidence used by recovery. */
export interface DocumentWriteIntentV1 {
  version: 1
  intentId: string
  phase: 'pending' | 'settled'
  at: number
}

export interface PendingDocumentWrite {
  intentId: string
  at: number
}

function valid(value: unknown): value is DocumentWriteIntentV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.version === 1 && typeof row.intentId === 'string' && row.intentId.length > 0 && row.intentId.length <= 256
    && (row.phase === 'pending' || row.phase === 'settled') && typeof row.at === 'number' && Number.isSafeInteger(row.at) && row.at >= 0
}

export function createDocumentIntentStore(filePath: string) {
  const append = async (intent: DocumentWriteIntentV1): Promise<void> => {
    if (!valid(intent)) throw new TypeError('Invalid document write intent')
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, JSON.stringify(intent) + '\n', 'utf8')
  }
  return {
    pending: (intentId: string) => append({ version: 1, intentId, phase: 'pending', at: Date.now() }),
    settled: (intentId: string) => append({ version: 1, intentId, phase: 'settled', at: Date.now() }),
    async pendingWrites(): Promise<PendingDocumentWrite[]> {
      const text = await readFile(filePath, 'utf8').catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return ''
        throw cause
      })
      const latest = new Map<string, DocumentWriteIntentV1>()
      for (const line of text.split('\n')) {
        if (!line) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue }
        if (valid(parsed)) latest.set(parsed.intentId, parsed)
      }
      return [...latest.values()].filter(intent => intent.phase === 'pending').map(intent => ({ intentId: intent.intentId, at: intent.at }))
    },
  }
}

export type DocumentIntentStore = ReturnType<typeof createDocumentIntentStore>

export async function readPendingDocumentWrites(coordinator: Pick<SessionCoordinator, 'storageRoot'>, stateId: string): Promise<PendingDocumentWrite[]> {
  if (!coordinator.storageRoot) return []
  return createDocumentIntentStore(join(coordinator.storageRoot, 'jobs', `${stateId}.write-intents.jsonl`)).pendingWrites()
}
