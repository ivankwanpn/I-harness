import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** S-07: file restoration and the rewind marker live in two durability domains.
 * Before touching files we write a durable intent; after the restoration and
 * marker settle we write completion. A crash leaves a pending intent, which is
 * the evidence that the workspace may have been restored without a marker. */
export interface RewindIntentV1 {
  version: 1
  intentId: string
  sessionId: string
  targetTurn: number
  mode: string
  phase: 'begin' | 'complete'
  at: number
}

export interface PendingRewindIntent {
  intentId: string
  targetTurn: number
  mode: string
  at: number
}

export interface RewindIntentHooks {
  begin(): Promise<void>
  complete(): Promise<void>
}

/** S-07 ordering: begin must settle before file restoration starts, and
 * completion only after the restoration/marker work returned. */
export async function runRewindRestoration<T>(intent: RewindIntentHooks | undefined, restore: () => Promise<T>): Promise<T> {
  await intent?.begin()
  const result = await restore()
  await intent?.complete()
  return result
}

const valid = (value: unknown): value is RewindIntentV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.version === 1 && typeof row.intentId === 'string' && row.intentId.length > 0 && row.intentId.length <= 256
    && typeof row.sessionId === 'string' && row.sessionId.length > 0 && row.sessionId.length <= 256
    && typeof row.targetTurn === 'number' && Number.isSafeInteger(row.targetTurn) && row.targetTurn >= 0
    && typeof row.mode === 'string' && row.mode.length <= 32
    && (row.phase === 'begin' || row.phase === 'complete')
    && typeof row.at === 'number' && Number.isSafeInteger(row.at) && row.at >= 0
}

const fileFor = (root: string, sessionId: string) => join(root, 'rewind-intents', `${sessionId}.jsonl`)

export function createRewindIntentLog(storageRoot: string | undefined, sessionId: string, targetTurn: number, mode: string): RewindIntentHooks | undefined {
  if (!storageRoot) return undefined
  const intentId = randomUUID(), file = fileFor(storageRoot, sessionId)
  const append = async (phase: RewindIntentV1['phase']): Promise<void> => {
    const record: RewindIntentV1 = { version: 1, intentId, sessionId, targetTurn, mode, phase, at: Date.now() }
    if (!valid(record)) throw new TypeError('Invalid rewind intent')
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify(record) + '\n', 'utf8')
  }
  return { begin: () => append('begin'), complete: () => append('complete') }
}

export async function readPendingRewindIntents(storageRoot: string | undefined, sessionId: string): Promise<PendingRewindIntent[]> {
  if (!storageRoot) return []
  const text = await readFile(fileFor(storageRoot, sessionId), 'utf8').catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return ''
    throw cause
  })
  const latest = new Map<string, RewindIntentV1>()
  for (const line of text.split('\n')) {
    if (!line) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { continue }
    if (valid(parsed)) latest.set(parsed.intentId, parsed)
  }
  return [...latest.values()].filter(intent => intent.phase === 'begin').map(intent => ({
    intentId: intent.intentId, targetTurn: intent.targetTurn, mode: intent.mode, at: intent.at,
  }))
}
