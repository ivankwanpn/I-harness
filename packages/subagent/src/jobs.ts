export type JobStatus = "running" | "completed" | "killed" | "error"
export interface JobSnapshot {
  id: string
  kind: string
  label: string
  status: JobStatus
  output: string
  // Task 4.4: wall-clock stamps (Date.now()) recorded on the live registry so
  // the web jobs surface can show elapsed/duration honestly. Additive —
  // undefined only for jobs created before this change in a restored snapshot
  // that carries no stamps (restore passes them through verbatim).
  startedAt?: number
  endedAt?: number
}
interface JobRecord extends JobSnapshot { owner: string; terminal: boolean }

export interface JobRegistry {
  // M24a (G2): `id` is optional — when provided (restore path) it is used
  // verbatim so persisted job ids survive resume; duplicates fail loud.
  // Task 4.4: `startedAt` (optional, restore path) seeds the creation stamp —
  // the live registry mints Date.now() when absent.
  registerJob(owner: string, kind: string, label: string, id?: string, startedAt?: number): { id: string }
  // M24a (G2/Ruling M24a-P4): returns false for an unknown id (observable
  // instead of a silent no-op). Existing callers may ignore the return.
  // Task 4.4: the patch may also carry startedAt/endedAt — the restore path
  // replays persisted stamps instead of re-minting them.
  updateJob(id: string, patch: Partial<Pick<JobSnapshot, "status" | "output" | "startedAt" | "endedAt">>): boolean
  read(id: string): JobSnapshot
  list(owner: string): JobSnapshot[]
  wait(id: string, timeoutMs: number): Promise<void>
  kill(id: string): "cancellation-requested" | "already-finished"
}

export function createJobRegistry(): JobRegistry {
  const records = new Map<string, JobRecord>()
  const counters = new Map<string, number>()
  function nextId(kind: string): string {
    const n = (counters.get(kind) ?? 0) + 1
    counters.set(kind, n)
    return `${kind}-${n}`
  }
  return {
    registerJob(owner: string, kind: string, label: string, id?: string, startedAt?: number) {
      const resolved = id ?? nextId(kind)
      // Fail loud on a persisted-id collision: silent re-count would break
      // post-resume jobId links (agent-table entries + followups).
      if (records.has(resolved)) throw new Error(`duplicate job id: ${resolved}`)
      // Task 4.4: start stamp — explicit (restore path) or minted now. A
      // restored terminal job's endedAt is replayed through updateJob below.
      records.set(resolved, { id: resolved, kind, label, status: "running", output: "", owner, terminal: false, startedAt: startedAt ?? Date.now() })
      // Ruling M24a-T1a: seed the per-kind counter from an explicitly
      // registered id ("<kind>-<n>"), so the auto generator continues AFTER
      // the highest known id. Without this, restoring a snapshot that
      // contains "subagent-1..N" leaves counters empty and the next auto id
      // is "subagent-1", colliding with the restored job and throwing
      // "duplicate job id" on every post-resume spawn. Chosen over making
      // nextId skip occupied ids: a single Math.max here keeps nextId pure,
      // preserves fail-loud for genuine duplicate claims (the collision
      // check above runs first), and is O(1) instead of scan-per-spawn.
      const m = id !== undefined ? new RegExp(`^${kind}-(\\d+)$`).exec(id) : null
      if (m) counters.set(kind, Math.max(counters.get(kind) ?? 0, Number(m[1])))
      return { id: resolved }
    },
    updateJob(id: string, patch: Partial<Pick<JobSnapshot, "status" | "output" | "startedAt" | "endedAt">>): boolean {
      const rec = records.get(id)
      if (!rec) return false // G2: unknown id is observable, not silent
      if (rec.terminal && patch.status !== "running") return true
      // Task 4.4: stamps — explicit patch values (restore path) win; a re-open
      // to "running" clears the end stamp (the same logical job is live again,
      // e.g. a followup turn on the same background agent).
      if (patch.startedAt !== undefined) rec.startedAt = patch.startedAt
      if (patch.endedAt !== undefined) rec.endedAt = patch.endedAt
      if (patch.status === "running") { rec.terminal = false; rec.endedAt = undefined }
      if (patch.status !== undefined) rec.status = patch.status
      if (patch.output !== undefined) rec.output = patch.output
      if (rec.status !== "running") { rec.terminal = true; rec.endedAt = rec.endedAt ?? Date.now() }
      return true
    },
    read(id: string) {
      const rec = records.get(id)
      if (!rec) throw new Error(`unknown job: ${id}`)
      return {
        id: rec.id, kind: rec.kind, label: rec.label, status: rec.status, output: rec.output,
        ...(rec.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
        ...(rec.endedAt !== undefined ? { endedAt: rec.endedAt } : {}),
      }
    },
    list(owner: string) {
      return [...records.values()].filter((r) => r.owner === owner)
        .map((r) => ({
          id: r.id, kind: r.kind, label: r.label, status: r.status, output: r.output,
          ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
          ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
        }))
    },
    async wait(id: string, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const rec = records.get(id)
        if (!rec || rec.terminal) return
        if (Date.now() >= deadline) return
        await new Promise((r) => setTimeout(r, 10))
      }
    },
    kill(id: string) {
      const rec = records.get(id)
      if (!rec) throw new Error(`unknown job: ${id}`)
      if (rec.terminal) return "already-finished"
      rec.status = "killed"
      rec.terminal = true
      rec.endedAt = rec.endedAt ?? Date.now()
      return "cancellation-requested"
    },
  }
}
