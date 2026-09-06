// M49 Task 12 — the read-only task projection at the subagent domain boundary
// (spec §8.2). The TEST FIXTURE CONTRACT: fixtureState() builds REAL
// registries through their public create/register methods (createAgentTable /
// createJobRegistry / createRoleRegistry / createTaskRegistry) — never object
// casts of private maps; the projection only READS.
import { describe, expect, it } from "vitest"
import { createSession } from "@i-harness/core-session"
import { createAgentTable, type ChildStatus } from "../src/agent-table.ts"
import { createJobRegistry, type JobStatus } from "../src/jobs.ts"
import { createRoleRegistry } from "../src/roles.ts"
import { createTaskRegistry } from "../src/task-protocol.ts"
import {
  projectAgentTasks,
  projectAgentTaskDetail,
  projectStatus,
  projectWorkflowRows,
  type AgentTaskStatus,
  type SubagentTaskSource,
  type TaskSourceStatus,
  type WorkflowTaskRow,
} from "../src/projection.ts"

// ------------------------------------------------------------------ fixture

interface FixtureAgent {
  id: string
  parentId?: string
  role?: string
  status: ChildStatus
  jobId?: string
}

interface FixtureJob {
  id: string
  agentId?: string
  status: JobStatus
  prompt?: string
}

/** Real subagent registries populated through the public create/register
 * methods — the projection contract (never object casts of private maps). */
function fixtureState(input: { agents?: FixtureAgent[]; jobs?: FixtureJob[] } = {}): SubagentTaskSource {
  const table = createAgentTable()
  for (const a of input.agents ?? []) {
    table.add(a.id, {
      path: a.id,
      status: a.status,
      session: createSession(),
      controller: new AbortController(),
      mailbox: [],
      ...(a.role !== undefined ? { roleName: a.role } : {}),
      ...(a.jobId !== undefined ? { jobId: a.jobId } : {}),
    })
  }
  const jobs = createJobRegistry()
  for (const j of input.jobs ?? []) {
    // The agent-side encoding the fixture uses: the job owner names the agent
    // lane the job belongs to (real spawns register owner "root"; the
    // projection links jobs to agents via BOTH the owner path and the agent
    // table's jobId backlink — see projection.ts).
    const { id } = jobs.registerJob(j.agentId ?? "root", "subagent", j.prompt ?? j.id, j.id)
    jobs.updateJob(id, { status: j.status, ...(j.prompt !== undefined ? { output: j.prompt } : {}) })
  }
  const roles = createRoleRegistry()
  roles.register({
    name: "helper",
    description: "helper role",
    systemPrompt: "help",
    tools: [],
  })
  roles.register({
    name: "miner",
    description: "miner role",
    systemPrompt: "mine",
    tools: [],
    model: { provider: "deepseek", model: "deepseek-chat" },
  })
  return { table, jobs, roles, tasks: createTaskRegistry() }
}

// ------------------------------------------------------------------ rows

describe("projectAgentTasks (spec §8.2)", () => {
  it("projects stable parent/child task rows without leaking registries", () => {
    const rows = projectAgentTasks(fixtureState({
      agents: [{ id: "root/helper", parentId: "root", role: "helper", status: "running" }],
      jobs: [{ id: "job-1", agentId: "root/helper", status: "running", prompt: "inspect code" }],
    }))
    expect(rows).toEqual([
      expect.objectContaining({
        id: "root/helper",
        parentId: "root",
        group: "subagent",
        label: "helper",
        status: "running",
        canCancel: true,
      }),
      expect.objectContaining({
        id: "job-1",
        parentId: "root/helper",
        group: "job",
        status: "running",
      }),
    ])
    // never an array-position synthesis, never a registry object on the row
    expect(rows.map((r) => r.id)).toEqual(["root/helper", "job-1"])
    for (const row of rows) {
      expect(row).not.toHaveProperty("entries")
      expect(row).not.toHaveProperty("records")
      expect(row).not.toHaveProperty("session")
    }
  })

  it("maps settled and recovered states honestly", () => {
    expect(projectStatus({ status: "completed" })).toBe("completed")
    expect(projectStatus({ status: "error" })).toBe("failed")
    expect(projectStatus({ status: "waiting" })).toBe("waiting")
    expect(projectStatus({ status: "cancelled" })).toBe("cancelled")
    expect(projectStatus({ status: "killed" })).toBe("cancelled")
    expect(projectStatus({ status: "accepted" })).toBe("queued")
    expect(projectStatus({ status: "recovery-required" })).toBe("failed")
    expect(projectStatus({ status: "running" })).toBe("running")
  })

  it("marks stale entries cancelled/queued and failing rows with an honest summary", () => {
    const rows = projectAgentTasks(fixtureState({
      agents: [
        { id: "root/helper", role: "helper", status: "completed" },
        { id: "root/miner", role: "miner", status: "error" },
      ],
      jobs: [
        { id: "job-1", agentId: "root/helper", status: "completed", prompt: "inspect code" },
        { id: "job-2", agentId: "root/miner", status: "error", prompt: "mine" },
      ],
    }))
    const helper = rows.find((r) => r.id === "root/helper")!
    const miner = rows.find((r) => r.id === "root/miner")!
    const job1 = rows.find((r) => r.id === "job-1")!
    const job2 = rows.find((r) => r.id === "job-2")!
    expect(helper.status).toBe("completed")
    expect(helper.canCancel).toBe(false)
    expect(miner.status).toBe("failed")
    expect(miner.canCancel).toBe(false)
    expect(job1.status).toBe("completed")
    expect(job1.canCancel).toBe(false)
    expect(job2.status).toBe("failed")
  })

  it("a running agent row removes the canCancel claim once its entry settles (registry truth, not UI guess)", () => {
    const state = fixtureState({
      agents: [{ id: "root/helper", role: "helper", status: "running" }],
      jobs: [{ id: "job-1", agentId: "root/helper", status: "running", prompt: "inspect code" }],
    })
    expect(projectAgentTasks(state).find((r) => r.id === "root/helper")!.canCancel).toBe(true)
    state.table.get("root/helper")!.status = "waiting"
    expect(projectAgentTasks(state).find((r) => r.id === "root/helper")!.canCancel).toBe(false)
  })

  it("surfaces orphan durable task records honestly (recovery-required never re-dispatched)", () => {
    const state = fixtureState()
    // A durable record that never reached the agent table (e.g. a restored
    // ambiguous attempt classified recovery-required — no live entry exists).
    state.tasks.submit({
      identity: { parentSessionId: "s1" },
      agentPath: "root/tried",
      description: "tried before resume",
      prompt: "do the thing",
      agent: "helper",
      delivery: "parent",
    })
    state.tasks.terminalize({
      taskId: state.tasks.list()[0]!.id,
      outcome: "recovery-required",
      error: "child log unavailable after resume",
      recoveryReason: "response-interrupted",
    })
    const rows = projectAgentTasks(state)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: state.tasks.list()[0]!.id,
      group: "subagent",
      label: "root/tried",
      status: "failed",
      canCancel: false,
    })
    expect(rows[0]!.summary).toContain("child log unavailable after resume")
  })
})

// ------------------------------------------------------------------ detail

describe("projectAgentTaskDetail (detail payload, server-side)", () => {
  it("includes role/model/parent prompt/result/error and transcript availability for subagent rows", () => {
    const state = fixtureState({
      agents: [{ id: "root/miner", role: "miner", status: "running" }],
      jobs: [{ id: "job-1", agentId: "root/miner", status: "running", prompt: "mine deep" }],
    })
    const row = projectAgentTasks(state)[0]!
    const detail = projectAgentTaskDetail(state, row)!
    expect(detail).toMatchObject({
      id: "root/miner",
      group: "subagent",
      role: "miner",
      model: "deepseek:deepseek-chat", // the role's configured model
    })
    expect(typeof detail.transcriptAvailability).toBe("string")
  })

  it("a role without a configured model reports inherited honestly; result/error ride the record", () => {
    const state = fixtureState({
      agents: [{ id: "root/helper", role: "helper", status: "running" }],
      jobs: [{ id: "job-1", agentId: "root/helper", status: "running", prompt: "inspect code" }],
    })
    const row = projectAgentTasks(state)[0]!
    const detail = projectAgentTaskDetail(state, row)!
    expect(detail.model).toBeUndefined() // the helper role has no model — parent's is inherited
  })
})

describe("projectStatus", () => {
  it("maps the full union to AgentTaskStatus without losing running/waiting/completed", () => {
    const toStatus = (s: string): AgentTaskStatus => projectStatus({ status: s as TaskSourceStatus })
    expect(toStatus("running")).toBe("running")
    expect(toStatus("waiting")).toBe("waiting")
    expect(toStatus("completed")).toBe("completed")
    expect(toStatus("error")).toBe("failed")
    expect(toStatus("killed")).toBe("cancelled")
    expect(toStatus("cancelled")).toBe("cancelled")
    expect(toStatus("accepted")).toBe("queued")
    expect(toStatus("recovery-required")).toBe("failed")
  })
})

// ------------------------------------------------------------------ workflow rows

describe("projectWorkflowRows", () => {
  it("projects workflow store rows under the workflow group with honest canCancel", () => {
    const rows = projectWorkflowRows([
      { id: "workflow-1", status: "running", stdout: "", stderr: "" },
      { id: "workflow-2", status: "completed", stdout: "ok", stderr: "" },
    ])
    expect(rows).toEqual([
      expect.objectContaining({ id: "workflow-1", group: "workflow", status: "running", canCancel: true }),
      expect.objectContaining({ id: "workflow-2", group: "workflow", status: "completed", canCancel: false }),
    ])
  })

  it("attributes workflow rows to the session that started them — no cross-session bleed (review finding 1)", () => {
    const rows: WorkflowTaskRow[] = [
      { id: "workflow-1", status: "running", stdout: "", stderr: "", owner: "s1" },
      { id: "workflow-2", status: "running", stdout: "", stderr: "", owner: "s2" },
      { id: "workflow-3", status: "completed", stdout: "", stderr: "" }, // non-session starter (run-level panel)
    ]
    // session A's projection shows ONLY A's run; session B never sees A's.
    expect(projectWorkflowRows(rows, "s1").map((r) => r.id)).toEqual(["workflow-1"])
    expect(projectWorkflowRows(rows, "s2").map((r) => r.id)).toEqual(["workflow-2"])
    // a session-less assembly (CLI one-shot) sees only unattributed rows.
    expect(projectWorkflowRows(rows).map((r) => r.id)).toEqual(["workflow-3"])
  })
})
