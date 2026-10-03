import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export interface NotificationEntry {
  id: string
  workspaceId: string
  sessionId: string
  kind: "question" | "approval"
  summary: string
  createdAt: string
  read: boolean
}
export interface NotificationHistoryView { items: NotificationEntry[]; unread: number }
export type NotificationInput = Pick<NotificationEntry, "id" | "workspaceId" | "sessionId" | "kind" | "summary">
export type NotificationHistoryRequest =
  | { kind: "desktop/notifications/list" }
  | { kind: "desktop/notifications/read"; id?: string }
  | { kind: "desktop/notifications/clear"; confirmed: true }

const queues = new Map<string, Promise<unknown>>()
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
const copyView = (items: NotificationEntry[]): NotificationHistoryView => ({ items: items.map(row => ({ ...row })), unread: items.filter(row => !row.read).length })

/** Only native display metadata is retained. Tool arguments, credentials and
 * execution authority never enter this file; a target is resolved again on open. */
export function createNotificationHistory(file: string, options: { maxItems?: number } = {}) {
  const path = resolve(file)
  const queueKey = process.platform === "win32" ? path.toLowerCase() : path
  const maxItems = options.maxItems ?? 200
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 500) throw new Error("Invalid notification history limit")
  async function load(): Promise<NotificationEntry[]> {
    let raw: string
    try {
      if ((await stat(path)).size > 1_048_576) throw new Error("Notification history is too large")
      raw = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    let document: unknown
    try { document = JSON.parse(raw) } catch { throw new Error("Notification history is invalid") }
    if (!record(document) || document.version !== 1 || !Array.isArray(document.items) || document.items.length > 500) throw new Error("Notification history is invalid")
    const ids = new Set<string>()
    const items = document.items.map((item): NotificationEntry => {
      if (!record(item) || !identifier(item.id) || ids.has(item.id) || !identifier(item.workspaceId) || !identifier(item.sessionId)
        || !["question", "approval"].includes(item.kind as string) || typeof item.summary !== "string" || item.summary.length > 512
        || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.read !== "boolean") throw new Error("Notification history entry is invalid")
      ids.add(item.id)
      return { id: item.id, workspaceId: item.workspaceId, sessionId: item.sessionId, kind: item.kind as NotificationEntry["kind"], summary: item.summary, createdAt: item.createdAt, read: item.read }
    })
    return items.slice(0, maxItems)
  }
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const job = (queues.get(queueKey) ?? Promise.resolve()).catch(() => undefined).then(work)
    queues.set(queueKey, job)
    void job.finally(() => { if (queues.get(queueKey) === job) queues.delete(queueKey) }).catch(() => undefined)
    return job
  }
  async function save(items: NotificationEntry[]) {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, items }), { encoding: "utf8", flag: "wx" })
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
  return {
    async flush() { await queues.get(queueKey) },
    list(): Promise<NotificationHistoryView> { return serial(async () => copyView(await load())) },
    record(input: NotificationInput): Promise<NotificationHistoryView> {
      if (!record(input) || !identifier(input.id) || !identifier(input.workspaceId) || !identifier(input.sessionId)
        || !["question", "approval"].includes(input.kind) || typeof input.summary !== "string") return Promise.reject(new Error("Invalid notification input"))
      const row: NotificationEntry = { id: input.id, workspaceId: input.workspaceId, sessionId: input.sessionId, kind: input.kind,
        summary: input.summary.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512), createdAt: new Date().toISOString(), read: false }
      return serial(async () => {
        const items = await load()
        if (items.some(item => item.id === row.id)) return copyView(items)
        const next = [row, ...items].slice(0, maxItems)
        await save(next)
        return copyView(next)
      })
    },
    markRead(id?: string): Promise<NotificationHistoryView> {
      if (id !== undefined && !identifier(id)) return Promise.reject(new Error("Invalid notification ID"))
      return serial(async () => {
        const next = (await load()).map(row => id === undefined || row.id === id ? { ...row, read: true } : row)
        await save(next)
        return copyView(next)
      })
    },
    clear(): Promise<NotificationHistoryView> { return serial(async () => { await save([]); return copyView([]) }) },
  }
}
