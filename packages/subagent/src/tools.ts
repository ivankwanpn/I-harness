import type { Tool } from "@i-harness/core-tools"
import type { SubagentToolDeps } from "./tools/types.ts"
export type { SubagentToolDeps } from "./tools/types.ts"
export { cancelSubtree } from "./tools/cancel.ts"
export { ensureResidentAgent } from "./followup/resident.ts"
export { driveFollowups, type FollowupDeps } from "./followup/drive.ts"
export { sweepPendingInbox } from "./followup/inbox.ts"
import { createSpawnTool } from "./tools/spawn.ts"
import { createWaitTool, createTaskOutputTool } from "./tools/wait.ts"
import { createListTool, createJobOutputTool, createJobListTool } from "./tools/status.ts"
import { createSendTool, createFollowupTool, createResumeTool } from "./tools/followup.ts"
import { createInterruptTool, createCloseTool, createJobKillTool, createStopTaskTool } from "./tools/cancel.ts"

export function createSubagentTools(deps: SubagentToolDeps): Tool[] {
  const spawnTool = createSpawnTool(deps)
  const waitTool = createWaitTool(deps)
  const listTool = createListTool(deps)
  const sendTool = createSendTool(deps)
  const interruptTool = createInterruptTool(deps)
  const followupTool = createFollowupTool(deps)
  const closeTool = createCloseTool(deps)
  const resumeTool = createResumeTool(deps)
  const jobOutputTool = createJobOutputTool(deps)
  const jobListTool = createJobListTool(deps)
  const jobKillTool = createJobKillTool(deps)
  const getTaskOutputTool = createTaskOutputTool(deps)
  const stopTaskTool = createStopTaskTool(deps)
  return [spawnTool, waitTool, listTool, sendTool, interruptTool, followupTool, closeTool, resumeTool, jobOutputTool, jobListTool, jobKillTool, getTaskOutputTool, stopTaskTool]
}
