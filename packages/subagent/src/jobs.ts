export type JobStatus = "running" | "completed" | "killed" | "error"
export interface JobSnapshot { id: string; kind: string; label: string; status: JobStatus; output: string }
interface JobRecord extends JobSnapshot { owner: string; terminal: boolean }

export interface JobRegistry {
  // M24a (G2): `id` is optional — when provided (restore path) it is used
  // verbatim so persisted job ids survive resume; duplicates fail loud.
  registerJob(owner: string, kind: string, label: string, id?: string): { id: string }
  // M24a (G2/Ruling M24a-P4): returns false for an unknown id (observable
  // instead of a silent no-op). Existing callers may ignore the return.
  updateJob(id: string, patch: Partial<Pick<JobSnapshot, "status" | "output">>): boolean
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
    registerJob(owner: string, kind: string, label: string, id?: string) {
      const resolved = id ?? nextId(kind)
      // Fail loud on a persisted-id collision: silent re-count would break
      // post-resume jobId links (agent-table entries + followups).
      if (records.has(resolved)) throw new Error(`duplicate job id: ${resolved}`)
      records.set(resolved, { id: resolved, kind, label, status: "running", output: "", owner, terminal: false })
      return { id: resolved }
    },
    updateJob(id: string, patch: Partial<Pick<JobSnapshot, "status" | "output">>): boolean {
      const rec = records.get(id)
      if (!rec) return false // G2: unknown id is observable, not silent
      if (rec.terminal && patch.status !== "running") return true
      if (patch.status === "running") rec.terminal = false
      if (patch.status !== undefined) rec.status = patch.status
      if (patch.output !== undefined) rec.output = patch.output
      if (rec.status !== "running") rec.terminal = true
      return true
    },
    read(id: string) {
      const rec = records.get(id)
      if (!rec) throw new Error(`unknown job: ${id}`)
      return { id: rec.id, kind: rec.kind, label: rec.label, status: rec.status, output: rec.output }
    },
    list(owner: string) {
      return [...records.values()].filter((r) => r.owner === owner)
        .map((r) => ({ id: r.id, kind: r.kind, label: r.label, status: r.status, output: r.output }))
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
      return "cancellation-requested"
    },
  }
}
