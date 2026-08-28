// @i-harness/workflow — static YAML workflows + single-job runner (M24b, spec §3.2).
// Definitions: <workspace>/workflow/*.yml → WorkflowRegistry (scan/reload).
// Execution: one run = ONE background job (`workflow-${n}`) in a
// WorkflowJobStore; createWorkflowExecutor exposes the ExecService-like job
// surface (runWorkflow/getOutput/listJobs/killJob) that Task 3's subagent
// job_* third layer consumes. Tools: workflow_run / workflow_list via
// registerWorkflow(ctx, tools, { workspace, exec }).
export {
  parseWorkflowYaml,
  isValidWorkflowName,
  WorkflowParseError,
  WORKFLOW_NAME_PATTERN,
  type WorkflowDefinition,
  type WorkflowParamSpec,
  type WorkflowStep,
} from "./definition.ts"
export {
  createWorkflowRegistry,
  type WorkflowRegistry,
  type WorkflowRegistryDeps,
} from "./registry.ts"
export {
  createWorkflowExecutor,
  createWorkflowJobStore,
  runWorkflow,
  runWorkflowIn,
  type WorkflowExecutor,
  type WorkflowExecutorDeps,
  type WorkflowJobEntry,
  type WorkflowJobStore,
  type WorkflowRunHandle,
} from "./runner.ts"
export {
  createWorkflowListTool,
  createWorkflowRunTool,
  registerWorkflow,
  workflowExecutorServiceName,
  workflowListName,
  workflowRunName,
  type WorkflowListEntry,
  type WorkflowListOutput,
  type WorkflowMountConfig,
  type WorkflowMountHandle,
  type WorkflowRunArgs,
  type WorkflowRunOutput,
} from "./tool.ts"
