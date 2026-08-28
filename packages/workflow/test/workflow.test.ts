// workflow.test.ts — TDD core (YAML 解析 + 執行 + single-job)。Spec §3.2/§5。
// All exec interactions go through mock ExecService objects — hermetic, no
// real spawns. Job-store isolation: tests that assert on job listings inject
// their own store (the default run-level shared store is process-global).
import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import type { ExecCommand, ExecResult, ExecService } from "@i-harness/exec"
import { parseWorkflowYaml } from "../src/definition.ts"
import type { WorkflowDefinition } from "../src/definition.ts"
import type { WorkflowExecutor } from "../src/runner.ts"
import { createWorkflowExecutor, createWorkflowJobStore, runWorkflow } from "../src/runner.ts"
import { createWorkflowRegistry } from "../src/registry.ts"
import { registerWorkflow, workflowListName, workflowRunName } from "../src/tool.ts"

const YAML = `name: release-check
description: Run build + tests
steps:
  - name: build
    command: "pnpm build"
    timeout_ms: 1000
  - name: test
    command: "pnpm test"
    on_failure: continue
`

function setupWorkspace(files?: Record<string, string>): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-wf-"))
  mkdirSync(join(ws, "workflow"), { recursive: true })
  for (const [name, content] of Object.entries(files ?? {})) writeFileSync(join(ws, "workflow", name), content)
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) }
}

const OK: ExecResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false }

// Mock ExecService: records every ExecCommand so tests can assert argv/cwd/env/
// timeout/abort wiring, with per-call scripted results (default exit 0).
function mockExec(script?: (cmd: ExecCommand, call: number) => ExecResult): { exec: ExecService; calls: ExecCommand[] } {
  const calls: ExecCommand[] = []
  const run = vi.fn(async (cmd: ExecCommand): Promise<ExecResult> => {
    calls.push(cmd)
    return script?.(cmd, calls.length - 1) ?? OK
  })
  return { exec: { run } as unknown as ExecService, calls }
}

function def(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: "x",
    description: "d",
    steps: [
      { name: "a", command: "echo a" },
      { name: "b", command: "echo b" },
    ],
    ...overrides,
  }
}

async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms)) // let the async loop run
}

it("scans <workspace>/workflow/*.yml", () => {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-wf-"))
  mkdirSync(join(ws, "workflow"), { recursive: true })
  writeFileSync(join(ws, "workflow/release-check.yml"), YAML)
  try {
    const reg = createWorkflowRegistry({ workspace: ws })
    expect(reg.get("release-check")?.steps).toHaveLength(2)
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

it("runWorkflow executes steps in order via exec.run(), single workflow-N job", async () => {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-wf-"))
  const { exec, calls } = mockExec()
  const d = { name: "x", description: "d", steps: [{ name: "a", command: "echo a" }, { name: "b", command: "echo b" }] }
  try {
    const { jobId } = runWorkflow(d, {}, exec)
    expect(jobId).toMatch(/^workflow-\d+$/)
    await settle() // let the async loop run
    // Recorder reconstructs each command from the parsed argv (argv[0] alone
    // is only the program name after shell-quote splitting).
    expect(calls.map((c) => c.argv.join(" "))).toEqual(["echo a", "echo b"])
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

describe("parseWorkflowYaml (fail-loud validation)", () => {
  it("parses a full definition: name/whenToUse/params/steps fields", () => {
    const parsed = parseWorkflowYaml(`name: release-check
description: Run build + tests
whenToUse: before cutting a release
params:
  target: { description: build target, default: dev }
  flag: { required: true }
steps:
  - name: build
    command: pnpm build --target \${target}
    cwd: sub/dir
    env: { NODE_ENV: production }
    timeout_ms: 300000
  - name: test
    command: pnpm test
    retry: { attempts: 2, backoff_ms: 1000 }
  - name: smoke
    command: pnpm smoke
    on_failure: continue
`)
    expect(parsed.name).toBe("release-check")
    expect(parsed.whenToUse).toBe("before cutting a release")
    expect(parsed.params?.target).toEqual({ description: "build target", default: "dev" })
    expect(parsed.params?.flag).toEqual({ required: true })
    expect(parsed.steps[0]).toMatchObject({ name: "build", command: "pnpm build --target \${target}", cwd: "sub/dir", timeout_ms: 300000 })
    expect(parsed.steps[0]?.env).toEqual({ NODE_ENV: "production" })
    expect(parsed.steps[1]?.retry).toEqual({ attempts: 2, backoff_ms: 1000 })
    expect(parsed.steps[2]?.on_failure).toBe("continue")
  })

  it("defaults name from the fallback (file stem) hint", () => {
    const parsed = parseWorkflowYaml("description: d\nsteps:\n  - name: a\n    command: c", { fallbackName: "my-check" })
    expect(parsed.name).toBe("my-check")
  })

  it("fails loud on missing description", () => {
    expect(() => parseWorkflowYaml("name: x\nsteps:\n  - name: a\n    command: c")).toThrowError(/description/)
  })

  it("fails loud on non-kebab name, empty steps, missing step command", () => {
    const opts = { fallbackName: "f" }
    expect(() => parseWorkflowYaml("name: Bad Name\ndescription: d\nsteps:\n  - name: a\n    command: c", opts)).toThrowError(/kebab/)
    expect(() => parseWorkflowYaml("name: x\ndescription: d\nsteps: []", opts)).toThrowError(/steps/)
    expect(() => parseWorkflowYaml("name: x\ndescription: d\nsteps:\n  - name: a", opts)).toThrowError(/command/)
    expect(() => parseWorkflowYaml("name: x\ndescription: d\nsteps:\n  - command: c", opts)).toThrowError(/name/)
  })

  it("fails loud on non-object YAML and invalid on_failure/retry shapes", () => {
    const opts = { fallbackName: "f" }
    expect(() => parseWorkflowYaml("- just\n- a list", opts)).toThrowError(/mapping/)
    expect(() => parseWorkflowYaml("name: x\ndescription: d\nsteps:\n  - name: a\n    command: c\n    on_failure: retry-forever", opts)).toThrowError(/on_failure/)
    expect(() => parseWorkflowYaml("name: x\ndescription: d\nsteps:\n  - name: a\n    command: c\n    retry: { attempts: 0 }", opts)).toThrowError(/attempts/)
  })
})

describe("registry", () => {
  it("warns and skips invalid files; lists sorted; reload() picks up new files", () => {
    const { ws, cleanup } = setupWorkspace({
      "b-second.yml": "description: second\nsteps:\n  - name: s\n    command: c\n",
      "a-first.yml": "steps:\n  - name: s\n    command: c\n", // missing description → skip
      "bad-name.yml": "name: Not Kebab\ndescription: d\nsteps:\n  - name: s\n    command: c\n",
      "ignored.txt": "name: nope\ndescription: d\nsteps: []",
    })
    const warns: string[] = []
    try {
      const reg = createWorkflowRegistry({ workspace: ws, onWarn: (m) => warns.push(m) })
      expect(reg.list().map((d) => d.name)).toEqual(["b-second"])
      expect(warns.length).toBe(2)
      expect(reg.get("nope")).toBeUndefined()
      expect(reg.get("not kebab")).toBeUndefined() // non-kebab query → undefined
      writeFileSync(join(ws, "workflow/c-third.yml"), "description: third\nsteps:\n  - name: s\n    command: c\n")
      expect(reg.list()).toHaveLength(1) // cached until reload()
      reg.reload()
      expect(reg.list().map((d) => d.name)).toEqual(["b-second", "c-third"])
    } finally { cleanup() }
  })

  it("missing workflow/ directory is an empty registry, not an error", () => {
    const ws = mkdtempSync(join(tmpdir(), "i-harness-wf-"))
    try {
      expect(createWorkflowRegistry({ workspace: ws }).list()).toEqual([])
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })
})

describe("runWorkflow execution semantics", () => {
  // Runs through an ISOLATED store so the assertions below can query the same
  // store the run registered into (hermetic across the shared default store).
  function runIsolated(exec: ExecService): { executor: WorkflowExecutor; run: (d: WorkflowDefinition, params?: Record<string, string>) => string } {
    const executor = createWorkflowExecutor({ exec, jobs: createWorkflowJobStore() })
    return { executor, run: (d, params) => executor.runWorkflow(d, params).jobId }
  }

  it("on_failure: stop (default) halts on failed step; remaining steps logged skipped, job error", async () => {
    const { exec, calls } = mockExec((_, i) => (i === 0 ? { ...OK, exitCode: 2 } : OK))
    const { executor, run } = runIsolated(exec)
    const jobId = run(def())
    await settle()
    expect(calls).toHaveLength(1) // step b never spawned
    const view = executor.getOutput(jobId)
    expect(view.status).toBe("error")
    expect(view.exitCode).toBe(2)
    expect(view.stdout).toContain("[step 1/2 a] started")
    expect(view.stdout).toContain("[step 1/2 a] failed(exit=2)")
    expect(view.stdout).toContain("[step 2/2 b] skipped")
    expect(view.stdout).not.toContain("[step 2/2 b] started")
  })

  it("on_failure: continue records failed(exit=N) and keeps going; any failure → job error (never partial-as-success)", async () => {
    const { exec, calls } = mockExec((_, i) => (i === 0 ? { stdout: "boom\n", stderr: "err\n", exitCode: 1, timedOut: false } : OK))
    const { executor, run } = runIsolated(exec)
    const d = def({ steps: [{ name: "a", command: "boom", on_failure: "continue" }, { name: "b", command: "echo b" }] })
    const jobId = run(d)
    await settle()
    expect(calls).toHaveLength(2)
    const view = executor.getOutput(jobId)
    expect(view.status).toBe("error")
    expect(view.exitCode).toBe(1)
    expect(view.stdout).toContain("[step 1/2 a] failed(exit=1)")
    expect(view.stdout).toContain("boom")
    expect(view.stdout).toContain("[step 2/2 b] ok")
  })

  it("params ${param} interpolated before spawn (param beats default; unknown ${} left as-is)", async () => {
    const { exec, calls } = mockExec()
    const d = def({
      params: { target: { default: "dev" }, mode: { description: "build mode" } },
      steps: [{ name: "build", command: "pnpm build --target ${target} --mode ${mode} --keep ${undeclared}" }],
    })
    runWorkflow(d, { target: "prod", mode: "debug" }, exec)
    await settle()
    expect(calls[0]?.argv).toEqual(["pnpm", "build", "--target", "prod", "--mode", "debug", "--keep", "${undeclared}"])
  })

  it("missing required param fails loud before any job is created", () => {
    const { exec } = mockExec()
    const d = def({ params: { flag: { required: true } }, steps: [{ name: "a", command: "c ${flag}" }] })
    expect(() => runWorkflow(d, {}, exec)).toThrowError(/required param/)
  })

  it("retry: attempts re-run the failed step (backoff between attempts) until ok", async () => {
    const { exec, calls } = mockExec((_, i) => (i === 0 ? { ...OK, exitCode: 1 } : OK))
    const { executor, run } = runIsolated(exec)
    const d = def({ steps: [{ name: "flaky", command: "flaky", retry: { attempts: 2, backoff_ms: 1 } }] })
    const jobId = run(d)
    await settle(80)
    expect(calls).toHaveLength(2)
    const view = executor.getOutput(jobId)
    expect(view.status).toBe("completed")
    expect(view.exitCode).toBe(0)
    expect(view.stdout).toContain("[step 1/1 flaky] started")
    expect(view.stdout).toContain("[step 1/1 flaky] failed(exit=1)")
    expect(view.stdout).toContain("[step 1/1 flaky] ok")
  })

  it("exhausted retries leave the job errored with the step exit code", async () => {
    const { exec, calls } = mockExec(() => ({ ...OK, exitCode: 3 }))
    const { executor, run } = runIsolated(exec)
    const d = def({ steps: [{ name: "bad", command: "bad", retry: { attempts: 2 } }] })
    const jobId = run(d)
    await settle()
    expect(calls).toHaveLength(2)
    const view = executor.getOutput(jobId)
    expect(view.status).toBe("error")
    expect(view.exitCode).toBe(3)
  })

  it("passes cwd/env/timeoutMs per step and appends step stdout to the job stream", async () => {
    const { exec, calls } = mockExec((cmd) => ({ stdout: `out-of-${cmd.argv[0]}\n`, stderr: "", exitCode: 0, timedOut: false }))
    const { executor, run } = runIsolated(exec)
    const d = def({
      steps: [
        { name: "a", command: "tool run", cwd: "sub", env: { NODE_ENV: "production" }, timeout_ms: 1234 },
      ],
    })
    const jobId = run(d)
    await settle()
    expect(calls[0]).toMatchObject({ argv: ["tool", "run"], cwd: "sub", env: { NODE_ENV: "production" }, timeoutMs: 1234 })
    expect(executor.getOutput(jobId).stdout).toContain("out-of-tool")
  })
})

describe("single-job executor (job_* third-layer contract)", () => {
  it("job ids are workflow-N; getOutput/listJobs expose BackgroundJobView shape", async () => {
    const store = createWorkflowJobStore()
    const { exec } = mockExec()
    const executor = createWorkflowExecutor({ exec, jobs: store })
    const first = executor.runWorkflow(def())
    const second = executor.runWorkflow(def())
    expect(first.jobId).toMatch(/^workflow-\d+$/)
    expect(Number(second.jobId.slice("workflow-".length))).toBeGreaterThan(Number(first.jobId.slice("workflow-".length)))
    expect(first.runId).toMatch(/^workflow-\d+$/)
    await settle()
    const view = executor.getOutput(first.jobId)
    expect(view).toMatchObject({ id: first.jobId, status: "completed", exitCode: 0 })
    expect(executor.listJobs().map((j) => j.id)).toEqual([first.jobId, second.jobId])
  })

  it("getOutput/killJob on unknown ids throw `unknown job: <id>` (subagent fallback chain contract)", () => {
    const executor = createWorkflowExecutor({ exec: mockExec().exec, jobs: createWorkflowJobStore() })
    expect(() => executor.getOutput("workflow-9999")).toThrowError(/unknown job/)
    expect(() => executor.killJob("workflow-9999")).toThrowError(/unknown job/)
  })

  it("killJob aborts the current step exec and marks the job killed; rest skipped", async () => {
    const store = createWorkflowJobStore()
    const hangs: ExecService = {
      run: (cmd: ExecCommand) => new Promise<ExecResult>((resolve) => {
        cmd.abortSignal?.addEventListener("abort", () => resolve({ stdout: "", stderr: "terminated", exitCode: 137, timedOut: false }), { once: true })
      }),
    } as unknown as ExecService
    const executor = createWorkflowExecutor({ exec: hangs, jobs: store })
    const d = def({ steps: [{ name: "hang", command: "sleep 100" }, { name: "never", command: "echo never" }] })
    const { jobId } = executor.runWorkflow(d)
    await settle(10)
    expect(executor.killJob(jobId)).toBe("cancellation-requested")
    await settle()
    const view = executor.getOutput(jobId)
    expect(view.status).toBe("killed")
    expect(view.stdout).toContain("[step 1/2 hang] started")
    expect(view.stdout).toContain("[step 2/2 never] skipped")
    expect(executor.killJob(jobId)).toBe("already-finished")
  })
})

describe("tools (workflow_run / workflow_list)", () => {
  it("workflow_run returns {run_id, job_id} immediately; wait=true blocks and returns the final view", async () => {
    const { ws, cleanup } = setupWorkspace({ "quick.yml": "description: quick\nsteps:\n  - name: a\n    command: echo a\n" })
    const { exec, calls } = mockExec((cmd) => ({ stdout: `ran:${cmd.argv[0]}\n`, stderr: "", exitCode: 0, timedOut: false }))
    try {
      const ctx = createContext()
      const tools = createToolRegistry(ctx)
      const handle = registerWorkflow(ctx, tools, { workspace: ws, exec })
      const run = tools.get(workflowRunName)
      const list = tools.get(workflowListName)
      expect(run).toBeDefined()
      expect(list).toBeDefined()
      const bg = (await run!.execute({ name: "quick" }, {})) as { run_id: string; job_id: string; status: string }
      expect(bg.status).toBe("running")
      expect(bg.job_id).toMatch(/^workflow-\d+$/)
      await settle()
      const waited = (await run!.execute({ name: "quick", wait: true }, {})) as { status: string; output: string; exit_code: number }
      expect(waited.status).toBe("completed")
      expect(waited.output).toContain("[step 1/1 a] ok")
      expect(waited.output).toContain("ran:echo")
      expect(waited.exit_code).toBe(0)
      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(ctx.services.get("workflow/executor")).toBe(handle.executor)
      await handle.unmount()
      expect(tools.get(workflowRunName)).toBeUndefined()
      expect(tools.get(workflowListName)).toBeUndefined()
    } finally { cleanup() }
  })

  it("workflow_list lists name/description/params/steps count and is read-only; unknown name fails loud", async () => {
    const { ws, cleanup } = setupWorkspace({
      "deploy.yml": "name: deploy\ndescription: Ship it\nwhenToUse: on release\nparams:\n  env: { default: staging }\nsteps:\n  - name: a\n    command: c\n  - name: b\n    command: c\n",
    })
    const { exec } = mockExec()
    try {
      const ctx = createContext()
      const tools = createToolRegistry(ctx)
      registerWorkflow(ctx, tools, { workspace: ws, exec })
      expect(tools.get(workflowListName)?.isReadOnly).toBe(true)
      const out = (await tools.get(workflowListName)!.execute({}, {})) as { workflows: Array<{ name: string; description: string; whenToUse?: string; params: Record<string, unknown>; steps: number }> }
      expect(out.workflows).toEqual([
        { name: "deploy", description: "Ship it", whenToUse: "on release", params: { env: { default: "staging" } }, steps: 2 },
      ])
      await expect(tools.get(workflowRunName)!.execute({ name: "nope" }, {})).rejects.toThrowError(/unknown workflow/)
    } finally { cleanup() }
  })
})
