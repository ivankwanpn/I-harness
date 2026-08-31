// ── Task 4.4: jobs 状态流基础版 (jobs status projection) ───────────────────
// The web's jobs surface is BOTH:
//   1. a projection of `job/status` session events (realtime fold — the SPA
//      watches the existing mux `session` stream, no new endpoint), and
//   2. a mapping of the subagent persistence snapshot doc (the durable jobs
//      record — GET /api/sessions/:id/jobs, the initial snapshot).
// Both produce the same JobView shape; the log fold is last-wins by jobId
// (the goal/change pattern) so a consumer rebuilding from the log alone gets
// the same list the doc yields.
//
// The durable doc shape (SubagentStateSnapshot from @i-harness/subagent) is
// INLINED structurally on purpose — web-host must NOT depend on
// @i-harness/subagent (its graph drags the whole subagent runtime); core-session
// inlines team/* the same way. The producer (subagent persist.ts) owns the
// shape; if it drifts the route's `jobs` mapping warns loudly (never silent).
import type { SessionEvent } from "@i-harness/core-session"

export type JobStatusView = "running" | "completed" | "killed" | "error"

/** One job row served to the SPA (exactly what the durable record offers — no invented fields). */
export interface JobView {
  jobId: string
  kind: string
  label: string
  status: JobStatusView
  /** Output availability (non-empty output string), NOT the output bytes — job_output remains the read path. */
  outputAvailable: boolean
  startedAt?: number
  endedAt?: number
}

/** GET /api/sessions/:id/jobs response body. */
export interface JobsView {
  jobs: JobView[]
}

// ── Task 5.5: kill outcome vocabulary (subagent JobRegistry.kill parity) ────
// The live registry's kill contract (packages/subagent jobs.ts): the request
// is recorded, or the job was already terminal. The web seam surfaces the SAME
// strings the model-facing job_kill tool reports, so the popover's kill
// button promises exactly what the registry does — no invented semantics.
export type JobKillOutcome = "cancellation-requested" | "already-finished"

/**
 * A kill request for a job id the live registry does not know (never
 * registered, or a foreign kind). The host maps it to 409 — the honest
 * "nothing to kill" answer, never a silent 200.
 */
export class JobKillUnknownJobError extends Error {
  readonly jobId: string
  constructor(jobId: string) {
    super(`unknown job: ${jobId}`)
    this.name = "JobKillUnknownJobError"
    this.jobId = jobId
  }
}

/**
 * Task 4.4 queue honesty baseline (5.2's READ-ONLY pending data source):
 * the web host's ONLY queue is the per-session command serialization chain
 * (host.ts commandStream — a second prompt waits behind the running turn; no
 * prompt storage, no reorder). This view reports the real busy state.
 */
export interface CommandQueueView {
  /** A command turn is currently executing for this session. */
  running: boolean
  /** Command turns registered but still waiting behind the running turn (a stream aborted while queued still counts until it settles). */
  queued: number
}

/** Structural view of subagent's DurableJobRecord (persist.ts) — see module header. */
interface DurableJobRecordLike {
  id: string
  kind: string
  label: string
  status: string
  output?: string
  startedAt?: number
  endedAt?: number
}

/** Structural view of subagent's SubagentStateSnapshot. */
interface SubagentStateDocLike {
  formatVersion?: number
  jobs?: unknown
}

/**
 * Map the subagent persistence snapshot doc to JobView[]:
 *   - doc with a `jobs` array → mapped rows (order preserved: insertion order
 *     of the registry — the frontend sorts for display);
 *   - anything else (absent doc, foreign/corrupt doc) → [] — honest empty, a
 *     session with no subagent jobs HAS no rows; the route warns about a
 *     foreign/malformed doc.
 */
export function projectJobsDoc(doc: unknown): JobView[] {
  if (doc === undefined || doc === null || typeof doc !== "object") return []
  const jobs = (doc as SubagentStateDocLike).jobs
  if (!Array.isArray(jobs)) return []
  return jobs.map((raw) => {
    const rec = raw as Partial<DurableJobRecordLike>
    const status = (rec.status ?? "error") as JobStatusView
    return {
      jobId: rec.id ?? "",
      kind: rec.kind ?? "",
      label: rec.label ?? "",
      status,
      outputAvailable: typeof rec.output === "string" && rec.output.length > 0,
      ...(typeof rec.startedAt === "number" ? { startedAt: rec.startedAt } : {}),
      ...(typeof rec.endedAt === "number" ? { endedAt: rec.endedAt } : {}),
    }
  })
}

/**
 * Fold `job/status` events last-wins by jobId (the goal/change whole-snapshot
 * contract — every event carries the COMPLETE post-change job). Events of
 * other types are ignored; a job first seen mid-log keeps whatever stamps its
 * first event carried (the producer emits full snapshots).
 */
export function foldJobs(events: SessionEvent[]): JobView[] {
  const byId = new Map<string, JobView>()
  for (const ev of events) {
    if (ev.type !== "job/status") continue
    const job = ev.job
    byId.set(job.jobId, {
      jobId: job.jobId,
      kind: job.kind,
      label: job.label,
      status: job.status,
      outputAvailable: job.outputAvailable,
      ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
      ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    })
  }
  return [...byId.values()]
}
