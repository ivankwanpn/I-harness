import type { Session } from "@i-harness/core-session"
import { append, derivePlanMode } from "@i-harness/core-session"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"

export const PLAN_MODE_SYSTEM_PROMPT =
  "You are in PLAN MODE. Produce a concrete plan (steps, files, order) as your reply. " +
  "Never execute file changes, shell commands, or any other side-effecting tool. " +
  "When your plan is complete, call exit_plan_mode."

export function enterPlanMode(session: Session, proposal: string): void {
  append(session, { type: "plan/mode", mode: "on", proposal })
  append(session, { type: "user/message", text: proposal })
}

export function exitPlanMode(session: Session): boolean {
  if (!derivePlanMode(session).active) return false
  append(session, { type: "plan/mode", mode: "off" })
  return true
}

export function createPlanModeTools(session: Session): Tool[] {
  return [{
    name: "exit_plan_mode",
    description: "Signal that the plan is complete and plan mode should end. No arguments.",
    inputSchema: { type: "object", properties: undefined, required: undefined },
    isReadOnly: true,
    execute: async () => ({ active: exitPlanMode(session) }),
  }]
}

export function ensurePlanModeTool(tools: ToolRegistry, session: Session): void {
  if (tools.get("exit_plan_mode")) return
  for (const tool of createPlanModeTools(session)) tools.register(tool)
}

// M1 Phase B Task 4: the withdraw half of the seam. Nothing in the tree calls it,
// and nothing should. The tool registry is created inside the session assembly and
// dies with it, `packages/session-executor/src/assembly.ts` wires the ensure half
// only, plan-mode OFF is a session-log event rather than a registry mutation
// (`exitPlanMode` above), and the upstream design keeps `exit_plan_mode` registered
// while plan mode is inactive so the request tool catalog stays stable. Wiring this
// would be the wrong fix, so the declaration stays as the recorded seam and only its
// export edge goes -- the reachability row `@i-harness/plan-mode#withdrawPlanModeTool`.
function withdrawPlanModeTool(tools: ToolRegistry): void {
  tools.unregister("exit_plan_mode")
}

// Kept only so `noUnusedLocals` (tsconfig.base.json:9), which cannot express a
// deliberately unread declaration, accepts the record above. Delete this line and
// the function together if the seam is ever wired or abandoned.
void withdrawPlanModeTool
