import type { Tool } from "@i-harness/core-tools"
import type { SubagentToolDeps } from "./types.ts"
import { randomUUID } from "node:crypto"
import { append } from "@i-harness/core-session"
import { declaredRoleModel, subagentModelSelectionDisabled, subagentModelSelectionGated } from "../child.ts"
import { driveFollowups } from "../followup/drive.ts"
import { ensureResidentAgent, followupDepsWithRebuild } from "../followup/resident.ts"

export function createSendTool(deps: SubagentToolDeps): Tool {
  const sendTool: Tool<{ target: string; message: string }, { queued: boolean }> = {
    name: "send_message",
    description: "Send a message to an existing subagent. Queued; does not trigger a new turn.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      // Durable inbox: append a model-hidden event through the child's mirror.
      append(entry.session, { type: "subagent/inbox", messageId: randomUUID(), message: args.message, provenance: { kind: "inherited", authority: "observation", scope: "turn", producer: "subagent.followup", ...(deps.childSessions?.parentSessionId ? { originSessionId: deps.childSessions.parentSessionId } : {}) } })
      entry.mailbox.push(args.message)
      return { queued: true }
    },
  }
  return sendTool
}

export function createFollowupTool(deps: SubagentToolDeps): Tool {
  const followupTool: Tool<{ target: string; message: string }, { delivered: boolean }> = {
    name: "followup_task",
    description: "Send a follow-up task to a subagent and trigger a new turn. Queues the message durably and wakes the child to process it as a serialized followup turn.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      // Durable inbox + wake: queue the message and drive a turn on the child.
      append(entry.session, { type: "subagent/inbox", messageId: randomUUID(), message: args.message, provenance: { kind: "inherited", authority: "observation", scope: "turn", producer: "subagent.followup", ...(deps.childSessions?.parentSessionId ? { originSessionId: deps.childSessions.parentSessionId } : {}) } })
      entry.mailbox.push(args.message)
      // M23 (Minor 4): inject the lazy rebuild so a wakeup for a restored
      // (fresh-registry) entry rebuilds the resident agent instead of
      // silently dropping the drive.
      if (entry.sessionId) void driveFollowups(followupDepsWithRebuild(deps), entry, entry.sessionId)
      return { delivered: true }
    },
  }
  return followupTool
}

export function createResumeTool(deps: SubagentToolDeps): Tool {
  const resumeTool: Tool<{ target: string }, { resumed: boolean }> = {
    name: "resume_agent",
    description: "Re-activate a previously settled subagent from its persisted session; queued inbox messages are processed.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const existing = deps.table.get(args.target)
      if (!existing) throw new Error(`unknown subagent: ${args.target}`)
      if (existing.status === "running") throw new Error(`subagent already running: ${args.target}`)
      if (existing.sessionId && deps.agents.get(existing.sessionId)) {
        // already resident (e.g. a waiting child) → just re-drive pending inbox
        void driveFollowups(followupDepsWithRebuild(deps), existing, existing.sessionId)
        return { resumed: true }
      }
      // M23 (Minor 4): the rebuild body moved into ensureResidentAgent so the
      // wakeup paths (driveFollowups / agent-team deliver gate) can lazily
      // rebuild a fresh-registry (post-resume) resident agent too. As an
      // explicit tool call, resume_agent still ERRORS on an unrebuildable
      // target instead of tolerating the false return like the wakeup paths.
      const roleName = existing.roleName ?? "general"
      const role = deps.roles.get(roleName)
      if (!role) throw new Error(`unknown role: ${roleName}`)
      if (!(await ensureResidentAgent(deps, existing))) {
        // After the role check the remaining failure modes are the role's model
        // — the switch refusing it, or the resolver — mirror spawnChild's error
        // shape so the resume diagnostics match the spawn path. The helper IS
        // the spawn path's helper, so the two cannot drift.
        const declared = declaredRoleModel(role, deps)
        if (subagentModelSelectionGated(deps, declared)) throw subagentModelSelectionDisabled(role.name)
        if (declared !== undefined) {
          const state = await deps.resolveModel(declared)
          if (state.status !== "ready") {
            throw new Error(`role '${role.name}' cannot resolve its model: ${state.reason}`)
          }
        }
        throw new Error(`could not resume subagent: ${args.target}`)
      }
      if (existing.sessionId) void driveFollowups(followupDepsWithRebuild(deps), existing, existing.sessionId)
      return { resumed: true }
    },
  }
  return resumeTool
}
