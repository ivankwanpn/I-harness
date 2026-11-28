import type { Tool } from "@i-harness/core-tools"
import type { SubagentToolDeps } from "./types.ts"
import { randomUUID } from "node:crypto"
import { committedFactSeqs } from "@i-harness/core-session"
import { childFactOwner } from '../child/document.ts'
import { declaredRoleModel, subagentModelSelectionDisabled, subagentModelSelectionGated } from "../child.ts"
import { driveFollowups } from "../followup/drive.ts"
import { pendingMailbox } from "../followup/mailbox.ts"
import { ensureResidentAgent, followupDepsWithRebuild } from "../followup/resident.ts"

async function queueInboxMessage(deps: SubagentToolDeps, target: string, message: string, signal: AbortSignal | undefined, wake: boolean): Promise<void> {
  const entry = deps.table.get(target)
  if (!entry) throw new Error(`unknown subagent: ${target}`)
  const owner = await childFactOwner(entry, deps.childSessions?.coordinator)
  const action = owner.beginAction(signal)
  try {
    committedFactSeqs(await action.facts.delivery.record({
      type: "subagent/inbox", messageId: randomUUID(), message,
      provenance: {
        kind: "inherited", authority: "observation", scope: "turn", producer: "subagent.followup",
        ...(deps.childSessions?.parentSessionId ? { originSessionId: deps.childSessions.parentSessionId } : {}),
      },
    }))
    if (entry.session !== owner.view || entry.factOwner !== owner || deps.table.get(target) !== entry) return
    const mailbox = pendingMailbox(entry)
    if (mailbox !== entry.mailbox) deps.table.update(target, entry, { mailbox })
    if (wake) {
      action.assertOpen()
      if (entry.sessionId) void driveFollowups(followupDepsWithRebuild(deps), entry, entry.sessionId, signal).catch(() => {})
    }
  } finally { action.finish() }
}

export function createSendTool(deps: SubagentToolDeps): Tool {
  const sendTool: Tool<{ target: string; message: string }, { queued: boolean }> = {
    name: "send_message",
    description: "Send a message to an existing subagent. Queued; does not trigger a new turn.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args, exec) => {
      await queueInboxMessage(deps, args.target, args.message, exec.abortSignal, false)
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
    execute: async (args, exec) => {
      await queueInboxMessage(deps, args.target, args.message, exec.abortSignal, true)
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
    execute: async (args, exec) => {
      const existing = deps.table.get(args.target)
      if (!existing) throw new Error(`unknown subagent: ${args.target}`)
      // Loading historical metadata never revives a removed Team worker.
      await childFactOwner(existing,deps.childSessions?.coordinator)
      if (existing.status === "running") throw new Error(`subagent already running: ${args.target}`)
      if (existing.sessionId && deps.agents.get(existing.sessionId)) {
        // already resident (e.g. a waiting child) → just re-drive pending inbox
        exec.abortSignal?.throwIfAborted()
        void driveFollowups(followupDepsWithRebuild(deps), existing, existing.sessionId, exec.abortSignal).catch(() => {})
        return { resumed: true }
      }
      // M23 (Minor 4): the rebuild body moved into ensureResidentAgent so the
      // wakeup paths (serialized followup delivery) can lazily
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
      exec.abortSignal?.throwIfAborted()
      if (existing.sessionId) void driveFollowups(followupDepsWithRebuild(deps), existing, existing.sessionId, exec.abortSignal).catch(() => {})
      return { resumed: true }
    },
  }
  return resumeTool
}
