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

export function withdrawPlanModeTool(tools: ToolRegistry): void {
  tools.unregister("exit_plan_mode")
}
