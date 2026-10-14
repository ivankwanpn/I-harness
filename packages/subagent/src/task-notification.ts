import type { TaskOutcome, TaskRegistry } from "./task-protocol.ts"
import type { InputDisplay } from "@i-harness/core-session"
import { boundedNotification, type ReportPolicy } from "./report-policy.ts"

/**
 * R-A1 (A-plan) 輸入接納契約 —— 本計畫（R-D2）消費的單一輸入接納面。
 *
 * Authoritative admission / delivery / wake contract:
 * docs/concurrency-and-wake.md (§1–2).
 *
 * This adapter seam is consumed by the notification drain below. CLI uses
 * SessionExecutor.submit; the service host can admit durable inputs first
 * and drive them separately. The contract records the current host mapping.
 * 未注入（undefined）= durable-only 交付（fail-closed，通知停 pending 不回退）。
 */
export interface ParentInputAdmission {
  admit(input: { sessionId: string; text: string; description: string; display?: InputDisplay }): Promise<void>
  /**
   * Currently a no-op in the CLI adapter: admit already wakes via submit().
   * Retained as a seam for a future executor needing a separate wake; the
   * session-executor service already uses that seam. See docs/concurrency-and-wake.md.
   */
  wake(sessionId: string): void
}

/** Permanent refusal after Stop/disposal. A temporary admission failure must
 * remain retryable; a stopped parent must retain the result without waking. */
export class ParentNotificationStoppedError extends Error {
  readonly code = "PARENT_NOTIFICATION_STOPPED"
  constructor(message = "parent notification admission stopped") { super(message); this.name = "ParentNotificationStoppedError" }
}

export function isParentNotificationStopped(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "PARENT_NOTIFICATION_STOPPED"
}

export function renderTaskNotification(state: TaskOutcome, taskId: string, description: string, text: string): string {
  const tag = state === "completed" ? "task_result" : "task_error"
  return [
    `<task id="${taskId}" state="${state}">`,
    `<summary>${description}</summary>`,
    `<${tag}>`,
    text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export interface NotificationDrainOptions {
  reportPolicy?: ReportPolicy
  tasks: TaskRegistry
  admit: ParentInputAdmission | undefined
  // R-D3: 父 session 本身已被取消（cancelTree root chain）→ 不交付（opencode suppress）。
  isSessionCancelled?: (sessionId: string) => boolean
}

const TASK_REPLY_TITLES: Record<TaskOutcome, string> = {
  completed: "Task reply ended",
  error: "Task reply error",
  cancelled: "Task reply cancelled",
  "recovery-required": "Task reply needs recovery",
}

export function createNotificationDrain(opts: NotificationDrainOptions): { drain: () => Promise<number> } {
  const isCancelled = opts.isSessionCancelled ?? (() => false)
  let drainChain: Promise<number> = Promise.resolve(0)
  return {
    // Idempotent: pending|error|(delivered && !woken) are the only candidates;
    // every transition re-checks the row's current status so a coalesced drain
    // cannot double-admit. Single-threaded per mount; the coordinator doc lease
    // covers cross-process (M23) for the underlying write.
    drain(): Promise<number> {
      const run = async () => {
        if (!opts.admit) return 0
        let delivered = 0
        let changed = false
        for (const n of opts.tasks.notifications()) {
          const candidate =
            n.status === "pending" || n.status === "error" ||
            (n.status === "delivered" && n.timeWoken === undefined)
          if (!candidate) continue
          changed = true
          opts.tasks.updateNotification(n.id, { attempts: n.attempts + 1, ...(n.status === "error" ? { error: undefined } : {}) })
          if (isCancelled(n.parentSessionId)) {
            opts.tasks.updateNotification(n.id, { status: "suppressed", error: "parent session cancelled before notification delivery", timeWoken: Date.now() })
            continue
          }
          try {
            if (opts.reportPolicy) await opts.tasks.retainResult(n.submissionId)
            // Retention may wait on storage while the parent delegation is
            // cancelled. Its completed child's result cannot authorize a wake.
            if (isCancelled(n.parentSessionId)) {
              opts.tasks.updateNotification(n.id, { status: "suppressed", error: "parent session cancelled before notification delivery", timeWoken: Date.now() })
              continue
            }
            const task = opts.tasks.get(n.submissionId)
            const reference = `get_task_output({task_ids:[${JSON.stringify(n.submissionId)}]}) (${task?.retention ?? "memory"})`
            await opts.admit.admit({
              sessionId: n.parentSessionId,
              text: opts.reportPolicy
                ? boundedNotification((text, description) => renderTaskNotification(n.state, n.submissionId, description, text), n.text, n.description, reference, opts.reportPolicy)
                : renderTaskNotification(n.state, n.submissionId, n.description, n.text),
              description: n.description,
              display: { kind: "task", title: `${TASK_REPLY_TITLES[n.state]}: ${n.description}`, body: n.text },
            })
            opts.tasks.updateNotification(n.id, { status: "delivered", timeDelivered: Date.now(), error: undefined })
            opts.tasks.updateNotification(n.id, { status: "woken", timeWoken: Date.now(), error: undefined })
            opts.admit.wake(n.parentSessionId)
            delivered += 1
          } catch (err) {
            opts.tasks.updateNotification(n.id, { status: isParentNotificationStopped(err) ? "suppressed" : "error", error: err instanceof Error ? err.message : String(err), ...(isParentNotificationStopped(err) ? { timeWoken: Date.now() } : {}) })
          }
        }
        // ADAPTATION (M26-D1, plan §written "await save()" unconditionally): a
        // cold-restore drain over an EMPTY outbox would mint an empty
        // `task-<stateId>` doc on every mount — two pre-existing CLI tests
        // assert exactly one *.jsonl per store dir. Save only when a row moved.
        if (changed) await opts.tasks.save()
        return delivered
      }
      if (!opts.reportPolicy) return run()
      const pending = drainChain.then(run)
      drainChain = pending.catch(() => 0)
      return pending
    },
  }
}
