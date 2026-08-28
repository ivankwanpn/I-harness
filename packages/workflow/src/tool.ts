// Model-facing workflow tools (spec §3.2 工具面): workflow_run (single entry
// to execute a registered workflow as one background job) and workflow_list
// (read-only index). Mounted beside registerSubagent (spec §4) — the tools
// compose the definitions registry with the job executor, and the executor is
// registered as the "workflow/executor" service so hosts (and Task 3's
// subagent job_* third layer) can consume getOutput/listJobs/killJob without
// reaching into the tool layer.
import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import type { ExecService } from "@i-harness/exec"
import type { WorkflowDefinition, WorkflowParamSpec } from "./definition.ts"
import type { WorkflowExecutor } from "./runner.ts"
import { createWorkflowExecutor } from "./runner.ts"
import type { WorkflowRegistry } from "./registry.ts"
import { createWorkflowRegistry } from "./registry.ts"

export const workflowRunName = "workflow_run"
export const workflowListName = "workflow_list"
export const workflowExecutorServiceName = "workflow/executor"

export interface WorkflowRunArgs {
  name: string
  params?: Record<string, string>
  wait?: boolean
}

export interface WorkflowRunOutput {
  run_id: string
  job_id: string
  // Background path (wait default false): "running" — the model collects with
  // the existing job_output(job_id, wait: true) and cancels with job_kill.
  // wait: true: the final status of the run (never "running" unless the tool's
  // own abort fired first — the job keeps running in that case).
  status: string
  // Present once waited: the job output stream (progress lines + step stdout).
  output?: string
  exit_code?: number
}

export interface WorkflowListEntry {
  name: string
  description: string
  whenToUse?: string
  params: Record<string, WorkflowParamSpec>
  steps: number
}

export interface WorkflowListOutput {
  workflows: WorkflowListEntry[]
}

const WAIT_POLL_MS = 20

function toListEntry(def: WorkflowDefinition): WorkflowListEntry {
  return {
    name: def.name,
    description: def.description,
    ...(def.whenToUse !== undefined ? { whenToUse: def.whenToUse } : {}),
    params: def.params ?? {},
    steps: def.steps.length,
  }
}

export function createWorkflowRunTool(deps: { registry: WorkflowRegistry; executor: WorkflowExecutor }): Tool<WorkflowRunArgs, WorkflowRunOutput> {
  return {
    name: workflowRunName,
    description:
      "Run a named workflow (a static multi-step command sequence from the workspace's workflow/ directory) as ONE background job. Returns {run_id, job_id} immediately — collect with job_output(job_id, wait: true), cancel with job_kill. wait: true blocks until the run finishes (short workflows only). Step commands are TOKENIZED, NOT shell-interpreted: no &&, pipes, redirects, or globs — each command is split as POSIX shell-quote tokens (quotes group; backslash escapes are consumed, so write Windows paths with forward slashes like C:/src, never C:\\src).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Workflow name (see workflow_list)." },
        params: { type: "object", additionalProperties: { type: "string" }, description: "Values for the workflow's declared ${param} slots (plain substitution, same trust as bash commands)." },
        wait: { type: "boolean", description: "Block until the run finishes instead of returning a job id (default false)." },
      },
      required: ["name"],
    },
    isReadOnly: false,
    // Guard-timeout ceiling for the wait=true blocking path; hosts without a
    // guard-timeout ignore this metadata. Not wired to the run itself: cancel
    // a running workflow with job_kill (the run-level AbortController).
    timeoutMs: 600_000,
    execute: async (args, exec) => {
      const def = deps.registry.get(args.name)
      if (!def) {
        const available = deps.registry.list().map((d) => d.name).join(", ")
        throw new Error(`unknown workflow: ${args.name}${available.length > 0 ? ` (available: ${available})` : " (no workflows registered)"}`)
      }
      const { runId, jobId } = deps.executor.runWorkflow(def, args.params ?? {})
      if (args.wait !== true) {
        return { run_id: runId, job_id: jobId, status: "running" }
      }
      // wait=true: poll the workflow job store until the run settles. The
      // tool's own abort (guard-timeout/session abort) stops WAITING — the
      // job itself keeps running and stays reachable via job_output/job_kill.
      const signal = exec.abortSignal
      let view = deps.executor.getOutput(jobId)
      while (view.status === "running" && !signal?.aborted) {
        await new Promise((r) => setTimeout(r, WAIT_POLL_MS))
        view = deps.executor.getOutput(jobId)
      }
      return {
        run_id: runId,
        job_id: jobId,
        status: view.status,
        output: view.stdout,
        ...(view.exitCode !== undefined ? { exit_code: view.exitCode } : {}),
      }
    },
  }
}

export function createWorkflowListTool(deps: { registry: WorkflowRegistry }): Tool<Record<string, never>, WorkflowListOutput> {
  return {
    name: workflowListName,
    description: "List registered workflows (name/description/whenToUse/params/steps) so workflow_run can be called with the right name and params.",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    execute: async () => ({ workflows: deps.registry.list().map(toListEntry) }),
  }
}

export interface WorkflowMountHandle {
  registry: WorkflowRegistry
  executor: WorkflowExecutor
  // Unregisters the tools (idempotent — unknown names are no-ops). The
  // executor service stays registered: core-plugin's service store has no
  // unregister seam, and the run-level ctx outlives every mount in v0
  // (same decision as the skills mount).
  unmount(): Promise<void>
}

export interface WorkflowMountConfig {
  workspace?: string
  // The ExecService workflow steps spawn through. run.ts passes its composed
  // exec service (spec §4: registerWorkflow(ctx, tools, { workspace, exec })).
  exec: ExecService
}

// run.ts wiring: registers the "workflow/executor" service + the
// workflow_run/workflow_list tools. Returns the handle so a host (or the
// plugin form, once one exists) can reclaim the tools.
export function registerWorkflow(ctx: PluginContext, tools: ToolRegistry, config: WorkflowMountConfig): WorkflowMountHandle {
  const registry = createWorkflowRegistry({ workspace: config.workspace ?? process.cwd() })
  const executor = createWorkflowExecutor({ exec: config.exec })
  ctx.services.register(workflowExecutorServiceName, executor)
  const runTool = createWorkflowRunTool({ registry, executor })
  const listTool = createWorkflowListTool({ registry })
  tools.register(runTool)
  tools.register(listTool)
  return {
    registry,
    executor,
    unmount: async () => {
      tools.unregister(workflowRunName)
      tools.unregister(workflowListName)
    },
  }
}
