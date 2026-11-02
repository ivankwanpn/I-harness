import { createTeamDeliveryFacts, teamFactOwner, managedTeamFactOwner } from '../facts.ts'
import { driveFollowups, ParentNotificationStoppedError, type FollowupDeps, type JobRegistry } from "@i-harness/subagent"
import type { TeamDeps, TeamSubagentDeps } from "../scheduler.ts"
import type { TeamFoldState } from "../fold.ts"
import type { createActivity } from "../activity.ts"
import { AgentPath } from "../agent-path.ts"
import type { DeliveryOutcome } from '../transact.ts'

// The target append/flush is the acknowledgement barrier. Preserve host reads
// after awaits, notification receivers, and the shared serialized child drive.
export function createTaskDelivery(
  teamId: string,
  state: TeamFoldState,
  deps: Pick<TeamDeps, "parentSession" | "managedParent" | "parentNotify" | "factOwner">,
  sub: Pick<TeamSubagentDeps, "childSessions" | "table" | "agents" | "jobs" | "ensureResident" | "followupGeneration" | "followupActivation" | "captureFollowupGeneration">,
  teamJobs: JobRegistry,
  activity: Pick<ReturnType<typeof createActivity>, "notify">,
  isUnmounted: () => boolean,
  originalOwner?: Pick<import('@i-harness/core-session').FactOwner,'beginAction'>,
) {
  const recordDelivery=createTeamDeliveryFacts()
  const ensureResident = sub.ensureResident?.bind(sub)
  const openGeneration = sub.followupGeneration?.bind(sub)
  const captureGeneration = sub.captureFollowupGeneration?.bind(sub)
  const activation = sub.followupActivation
  const queued = (via: 'no-target-call' | 'bridge-false' | 'target-owned', sendFailure: DeliveryOutcome['sendFailure'] = { occurred: false }): DeliveryOutcome => ({ kind: 'queued', via, sendFailure })
  const consumed = (via: 'target' | 'parent-stop' = 'target', sendFailure: DeliveryOutcome['sendFailure'] = { occurred: false }): DeliveryOutcome => ({ kind: 'consumed', via, sendFailure })
  const realDeliver = async (targetId: string, messageId: string, content: string, delivery: "quiet" | "wakeup", _signal?: AbortSignal): Promise<DeliveryOutcome> => {
    if (targetId === teamId) {
      const managed=deps.managedParent
      const hasMessage=()=>managed ? (managed.parent.assertCurrent(),managed.parent.hasInbox(messageId)) : deps.parentSession!.events.some(event=>event.type==='subagent/inbox'&&event.messageId===messageId)
      if (!hasMessage()) {
        try { await recordDelivery(originalOwner ?? (managed ? managedTeamFactOwner(managed.domain) : teamFactOwner(deps.parentSession!,deps.factOwner)), { type: "subagent/inbox", messageId, message: content, provenance: { kind: "child-report", authority: "observation", scope: "turn", producer: "team.delivery" } }) }
        catch { return queued('target-owned') }
      }
      if (deps.parentNotify) {
        const message = (state.queued.get(teamId) ?? []).find((message) => message.id === messageId)
        const sender = message?.senderName ?? "teammate"
        try {
          await deps.parentNotify.admit({
            sessionId: sub.childSessions?.parentSessionId ?? teamId, text: `Team message <${messageId}> from <${sender}>:\n${content}`, description: `Team message from ${sender}`,
            display: message?.display ?? { kind: "team-message", title: `Team message from ${sender}`, body: message?.content ?? content },
          })
        } catch (error) {
          // Explicit Stop/disposal keeps the durable inbox audit but consumes
          // this notification so restart cannot silently reawaken the Lead.
          return error instanceof ParentNotificationStoppedError ? consumed('parent-stop') : queued('target-owned')
        }
        try { if (!isUnmounted()) deps.parentNotify.wake(sub.childSessions?.parentSessionId ?? teamId) }
        catch { return queued('target-owned') }
      }
      try { activity.notify() }
      catch (error) { return consumed('target', { occurred: true, error }) }
      return consumed()
    }
    const member = [...state.members.values()].find((m) => m.id === targetId)
    if (!member) return queued('no-target-call')
    const entry = sub.table.get(AgentPath.parse(`lead/${member.name}`).toString())
    // No live child (or a dead one): return false so the mailbox keeps the
    // message queued — recoverRoot re-delivers once the child is alive again
    // (e.g. after resume_agent).
    // M23 (Minor 4): a post-resume teammate carries status "error"
    // (restoreState maps running/waiting → "error") with a fresh-empty
    // Agent registry. With the rebuild seam injected, rebuild the resident
    // agent FIRST and proceed only on success; without the seam keep the
    // conservative message-stays-queued behavior.
    if (!entry) return queued('no-target-call')
    if (entry.status === "error") {
      if (!ensureResident) return queued('no-target-call')
      let ok: boolean
      try { ok = await ensureResident(entry) }
      catch (error) { return queued('no-target-call', { occurred: true, error }) }
      if (!ok) return queued('no-target-call')
    }
    if (entry.status === "killed") return queued('no-target-call')
    if(!entry.session.events.some(event=>event.type==='subagent/inbox'&&event.messageId===messageId)){
      try { await recordDelivery(teamFactOwner(entry.session,entry.factOwner), { type: "subagent/inbox", messageId, message: content, provenance: { kind: "child-report", authority: "observation", scope: "turn", producer: "team.delivery" } }) }
      catch { return queued('target-owned') }
      try { entry.mailbox.push(content) }
      catch (error) { return consumed('target', { occurred: true, error }) }
    }
    try { if (delivery === "wakeup" && entry.sessionId) {
      // Wake: drive the serialized followup chain (shared with subagent via
      // the exported driveFollowups, M19 Ruling 28 — NOT a duplicate vendor)
      // — only AFTER the append above, so the message is durably in the
      // target's session before the child sees it.
      // M23 (Minor 4): pass the rebuild seam through as driveFollowups'
      // optional `rebuild` so the drain recovers a missing resident agent
      // even when the gate above did not rebuild (e.g. a waiting entry whose
      // registry entry was dropped). Without the seam this is the unchanged
      // sub object (structural FollowupDeps).
      const wakeDeps: FollowupDeps = { ...sub, jobs: teamJobs, activation, captureGeneration, openGeneration, ...(ensureResident ? { rebuild: ensureResident } : {}) }
      const chain = driveFollowups(wakeDeps, entry, entry.sessionId)
      // M19 Ruling 26: the followup drain flips the child's status
      // (waiting→running→waiting); a wait_agent waiter must wake on that
      // edge even though no team event is appended.
      void chain.then(() => activity.notify()).catch(() => {})
    } } catch (error) { return consumed('target', { occurred: true, error }) }
    return consumed()
  }
  return realDeliver
}
