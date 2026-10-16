import type { SessionView as Session, MetadataFactSource } from "@i-harness/core-session"
import { committedFactSeqs, metadataFactsFor, derivePlanMode } from "@i-harness/core-session"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"

export const PLAN_MODE_SYSTEM_PROMPT =
  "You are in PLAN MODE. Produce a concrete plan (steps, files, order) as your reply. " +
  "Never execute file changes, shell commands, or any other side-effecting tool. " +
  "When your plan is complete, call exit_plan_mode."

export async function enterPlanMode(session: Session, proposal: string, facts?: MetadataFactSource): Promise<void> {
  committedFactSeqs(await metadataFactsFor(session, facts).enterPlan(proposal))
}

export async function exitPlanMode(session: Session, facts?: MetadataFactSource): Promise<boolean> {
  if (!derivePlanMode(session).active) return false
  committedFactSeqs(await metadataFactsFor(session, facts).admit({ type: "plan/mode", mode: "off" }))
  return true
}

export function createPlanModeTools(session: Session, facts?: MetadataFactSource): Tool[] {
  return [{
    name: "exit_plan_mode",
    description: "Signal that the plan is complete and plan mode should end. No arguments.",
    inputSchema: { type: "object", properties: undefined, required: undefined },
    isReadOnly: true,
    execute: async (_args, exec) => ({ active: await exitPlanMode(session, metadataFactsFor(session, facts, exec.abortSignal)) }),
  }]
}

export function ensurePlanModeTool(tools: ToolRegistry, session: Session, facts?: MetadataFactSource): void {
  if (tools.get("exit_plan_mode")) return
  for (const tool of createPlanModeTools(session, facts)) tools.register(tool)
}
