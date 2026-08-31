import { describe, expect, it } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import { JobKillUnknownJobError, foldJobs, projectJobsDoc } from "../src/index.ts"

// The subagent layer's persisted snapshot shape (SubagentStateSnapshot —
// structurally what persist.ts puts under stateId; this package maps it
// without depending on @i-harness/subagent, see jobs.ts).
const DOC = {
  formatVersion: 1,
  jobs: [
    { id: "subagent-1", owner: "root", kind: "subagent", label: "helper", status: "running", output: "", terminal: false, startedAt: 1000 },
    { id: "subagent-2", owner: "root", kind: "subagent", label: "reporter", status: "completed", output: "done", terminal: true, startedAt: 500, endedAt: 900 },
  ],
  agentTable: [],
  roles: [],
}

describe("foldJobs (job/status log projection)", () => {
  it("folds last-wins by jobId; ignores other event types; keeps the producer's full snapshots", () => {
    const events: SessionEvent[] = [
      { type: "job/status", version: 1, job: { jobId: "s1", kind: "subagent", label: "helper", status: "running", outputAvailable: false, startedAt: 1 } },
      { type: "job/status", version: 1, job: { jobId: "s2", kind: "subagent", label: "other", status: "running", outputAvailable: false, startedAt: 2 } },
      { type: "turn/start" },
      { type: "job/status", version: 1, job: { jobId: "s1", kind: "subagent", label: "helper", status: "completed", outputAvailable: true, startedAt: 1, endedAt: 9 } },
    ]
    const jobs = foldJobs(events)
    expect(jobs).toHaveLength(2)
    const s1 = jobs.find((j) => j.jobId === "s1")!
    expect(s1).toEqual({ jobId: "s1", kind: "subagent", label: "helper", status: "completed", outputAvailable: true, startedAt: 1, endedAt: 9 })
    expect(jobs.find((j) => j.jobId === "s2")!.status).toBe("running")
  })

  // Task 4.4 (fix round 1) regression: a resumed doc maps a mid-flight job to
  // "error" (persist.ts restoreState) and the fixed subagent layer REPLAYS that
  // outcome as a terminal `job/status` event after wiring, so the fold agrees
  // with the doc BOTH ways: (a) fold of the whole replayed log (the pre-crash
  // "running" event followed by the terminal event), and (b) doc-seed first
  // then folding only the events that landed after the seed (the terminal
  // event alone). Without the fix, both folds yield forever-"running".
  it("resume fold agreement: [running, terminal] and [terminal] both fold to error (never stuck running)", () => {
    const runningEvent: SessionEvent = {
      type: "job/status", version: 1,
      job: { jobId: "subagent-1", kind: "subagent", label: "helper", status: "running", outputAvailable: false, startedAt: 10 },
    }
    const terminalEvent: SessionEvent = {
      type: "job/status", version: 1,
      job: { jobId: "subagent-1", kind: "subagent", label: "helper", status: "error", outputAvailable: true, startedAt: 10, endedAt: 99 },
    }
    // (a) whole replayed log
    expect(foldJobs([runningEvent, terminalEvent])[0]?.status).toBe("error")
    // (b) doc-seeded consumer folding the post-seed events
    expect(foldJobs([terminalEvent])[0]?.status).toBe("error")
  })
})

describe("projectJobsDoc", () => {
  it("maps the snapshot doc structurally (undefined/foreign → empty)", () => {
    expect(projectJobsDoc(undefined)).toEqual([])
    expect(projectJobsDoc("garbage")).toEqual([])
    expect(projectJobsDoc([])).toEqual([])
    expect(projectJobsDoc(DOC)).toHaveLength(2)
  })

  it("maps stamps + output availability, preserving doc order", () => {
    expect(projectJobsDoc(DOC)).toEqual([
      { jobId: "subagent-1", kind: "subagent", label: "helper", status: "running", outputAvailable: false, startedAt: 1000 },
      { jobId: "subagent-2", kind: "subagent", label: "reporter", status: "completed", outputAvailable: true, startedAt: 500, endedAt: 900 },
    ])
  })
})

describe("JobKillUnknownJobError (kill-bridge vocabulary)", () => {
  it("carries the jobId and an honest message (host maps to 409)", () => {
    const error = new JobKillUnknownJobError("ghost-job")
    expect(error.name).toBe("JobKillUnknownJobError")
    expect(error.jobId).toBe("ghost-job")
    expect(error.message).toBe("unknown job: ghost-job")
  })
})
