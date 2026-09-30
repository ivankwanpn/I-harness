import { createHash } from "node:crypto"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { GuardianReviewRecord } from "@i-harness/guard-approval"

const LIMIT = 100
const statuses = new Set(["completed", "timeout", "cancelled", "malformed", "operational", "breaker"])
const outcomes = new Set(["approve", "allow", "deny"])
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
function normalize(value: unknown): GuardianReviewRecord | undefined {
  if (!object(value) || typeof value.id !== "string" || !value.id || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)
    || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0
    || typeof value.status !== "string" || !statuses.has(value.status) || typeof value.reusedContext !== "boolean"
    || typeof value.rationale !== "string" || !object(value.request)) return undefined
  const request = value.request
  if (typeof request.name !== "string" || typeof request.reason !== "string" || typeof request.args !== "string") return undefined
  const sourceModel = value.model
  const model = object(sourceModel) ? Object.fromEntries(["provider", "model", "protocol", "reasoningEffort"].flatMap((key) =>
    typeof sourceModel[key] === "string" ? [[key, sourceModel[key].slice(0, 256)]] : [])) : undefined
  return {
    id: value.id.slice(0, 128), startedAt: value.startedAt, durationMs: value.durationMs, status: value.status as GuardianReviewRecord["status"],
    request: { name: request.name.slice(0, 256), reason: request.reason.slice(0, 2000), args: request.args.slice(0, 16000), argsTruncated: request.argsTruncated === true || request.args.length > 16000 },
    reusedContext: value.reusedContext, rationale: value.rationale.slice(0, 2000), ...(model ? { model } : {}),
    ...(typeof value.outcome === "string" && outcomes.has(value.outcome) ? { outcome: value.outcome as GuardianReviewRecord["outcome"] } : {}),
    ...(typeof value.reviewerOutcome === "string" && outcomes.has(value.reviewerOutcome) ? { reviewerOutcome: value.reviewerOutcome as GuardianReviewRecord["reviewerOutcome"] } : {}),
    ...(typeof value.reviewerRationale === "string" ? { reviewerRationale: value.reviewerRationale.slice(0, 2000) } : {}),
    ...(value.cause === "timeout" || value.cause === "malformed" || value.cause === "operational" ? { cause: value.cause } : {}),
  }
}

/** Approval inspection is a separate bounded document, never a conversation
 * log. A per-session chain prevents concurrent tool reviews losing records. */
export function createDesktopApprovalHistory(coordinator: SessionCoordinator) {
  const writes = new Map<string, Promise<void>>()
  const key = (sessionId: string) => `approval-history-${createHash("sha256").update(sessionId).digest("hex")}`
  async function readDocument(sessionId: string): Promise<GuardianReviewRecord[]> {
    await coordinator.profile(sessionId)
    const document = await coordinator.getDocument(key(sessionId))
    if (!object(document) || document.version !== 1 || !Array.isArray(document.records)) return []
    return document.records.slice(-LIMIT).map(normalize).filter((row): row is GuardianReviewRecord => row !== undefined)
  }
  return {
    async read(sessionId: string): Promise<GuardianReviewRecord[]> { await writes.get(sessionId); return readDocument(sessionId) },
    async append(sessionId: string, record: GuardianReviewRecord): Promise<void> {
      const bounded = normalize(record)
      if (!bounded) throw new Error("Invalid approval history record")
      const previous = writes.get(sessionId) ?? Promise.resolve()
      const write = previous.catch(() => {}).then(async () => {
        const rows = await readDocument(sessionId)
        await coordinator.putDocument(key(sessionId), { version: 1, records: [...rows, bounded].slice(-LIMIT) })
      })
      writes.set(sessionId, write)
      try { await write }
      finally { if (writes.get(sessionId) === write) writes.delete(sessionId) }
    },
    async flush(): Promise<void> { await Promise.all(writes.values()) },
  }
}
