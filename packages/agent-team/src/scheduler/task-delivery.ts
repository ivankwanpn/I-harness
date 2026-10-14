import { append } from "@i-harness/core-session"
import { driveFollowups, isParentNotificationStopped, type FollowupDeps, type ChildAgentEntry, type JobRegistry } from "@i-harness/subagent"
import type { TeamDeps, TeamSubagentDeps } from "../scheduler.ts"
import type { TeamFoldState } from "../fold.ts"
import type { createActivity } from "../activity.ts"
import { AgentPath } from "../agent-path.ts"

// The target append/flush is the acknowledgement barrier. Preserve host reads
// after awaits, notification receivers, and the shared serialized child drive.
export function createTaskDelivery(
  teamId: string,
  state: TeamFoldState,
  deps: Pick<TeamDeps, "parentSession" | "parentNotify">,
  sub: Pick<TeamSubagentDeps, "childSessions" | "table" | "agents" | "jobs" | "ensureResident">,
  teamJobs: JobRegistry,
  activity: Pick<ReturnType<typeof createActivity>, "notify">,
  isUnmounted: () => boolean,
) {
  const realDeliver = async (targetId: string, messageId: string, content: string, delivery: "quiet" | "wakeup", _signal?: AbortSignal): Promise<boolean> => {
    if (targetId === teamId) {
      // Lead is always live: durably record the message in the parent session
      // log (subagent/inbox-style event; the parent's mirror persists it).
      // Flush the parent's write-behind so the ack means on-disk.
      if (!deps.parentSession.events.some((event) => event.type === "subagent/inbox" && event.messageId === messageId)) append(deps.parentSession, { type: "subagent/inbox", messageId, message: content })
      if (sub.childSessions) {
        try {
          await sub.childSessions.coordinator.flush(sub.childSessions.parentSessionId)
        } catch {
          // FAIL CLOSED (Ruling 22): the flush is the durability point — a
          // rejection means the message may still be in the volatile
          // write-behind. Returning true would let the mailbox append
          // delivered and recoverRoot skip this id forever. False keeps it
          // queued (at-least-once) for a recoverRoot retry.
          return false
        }
      }
      if (deps.parentNotify) {
        const queued = (state.queued.get(teamId) ?? []).find((message) => message.id === messageId)
        const sender = queued?.senderName ?? "teammate"
        try {
          await deps.parentNotify.admit({
            sessionId: sub.childSessions?.parentSessionId ?? teamId, text: `Team message <${messageId}> from <${sender}>:\n${content}`, description: `Team message from ${sender}`,
            display: queued?.display ?? { kind: "team-message", title: `Team message from ${sender}`, body: queued?.content ?? content },
          })
          if (!isUnmounted()) deps.parentNotify.wake(sub.childSessions?.parentSessionId ?? teamId)
        } catch (error) {
          // Explicit Stop/disposal keeps the durable inbox audit but consumes
          // this notification so restart cannot silently reawaken the Lead.
          return isParentNotificationStopped(error)
        }
      }
      activity.notify()
      return true
    }
    const member = [...state.members.values()].find((m) => m.id === targetId)
    if (!member) return false
    const entry = sub.table.get(AgentPath.parse(`lead/${member.name}`).toString())
    // No live child (or a dead one): return false so the mailbox keeps the
    // message queued — recoverRoot re-delivers once the child is alive again
    // (e.g. after resume_agent).
    // M23 (Minor 4): a post-resume teammate carries status "error"
    // (restoreState maps running/waiting → "error") with a fresh-empty
    // Agent registry. With the rebuild seam injected, rebuild the resident
    // agent FIRST and proceed only on success; without the seam keep the
    // conservative message-stays-queued behavior.
    if (!entry) return false
    if (entry.status === "error") {
      if (!sub.ensureResident) return false
      const ok = await sub.ensureResident(entry)
      if (!ok) return false
    }
    if (entry.status === "killed") return false
    // Durable inbox write: append through the child's mirror (spawnChild's
    // session hook enqueues every append to the coordinator write-behind),
    // then update the live mailbox mirror.
    append(entry.session, { type: "subagent/inbox", messageId, message: content })
    entry.mailbox.push(content)
    // FLUSH BEFORE ACK: true must mean the message is on disk in the target's
    // session (binding: "durably in the target's session before returning
    // true"). A crash right after this returns true must not lose it — the
    // mailbox's delivered marker is only appended after this resolves.
    if (entry.sessionId && sub.childSessions) {
      try {
        await sub.childSessions.coordinator.flush(entry.sessionId)
      } catch {
        // FAIL CLOSED (Ruling 22): see the lead branch — flush rejection ⇒
        // not durably delivered ⇒ return false so the message stays queued.
        return false
      }
    }
    if (delivery === "wakeup" && entry.sessionId) {
      // Wake: drive the serialized followup chain (shared with subagent via
      // the exported driveFollowups, M19 Ruling 28 — NOT a duplicate vendor)
      // — only AFTER the append above, so the message is durably in the
      // target's session before the child sees it.
      // M23 (Minor 4): pass the rebuild seam through as driveFollowups'
      // optional `rebuild` so the drain recovers a missing resident agent
      // even when the gate above did not rebuild (e.g. a waiting entry whose
      // registry entry was dropped). Without the seam this is the unchanged
      // sub object (structural FollowupDeps).
      const wakeDeps: FollowupDeps = { ...sub, jobs: teamJobs, ...(sub.ensureResident ? { rebuild: (e: ChildAgentEntry) => sub.ensureResident!(e) } : {}) }
      const chain = driveFollowups(wakeDeps, entry, entry.sessionId)
      // M19 Ruling 26: the followup drain flips the child's status
      // (waiting→running→waiting); a wait_agent waiter must wake on that
      // edge even though no team event is appended.
      void chain.then(() => activity.notify()).catch(() => {})
    }
    return true
  }
  return realDeliver
}
