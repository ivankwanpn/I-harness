import type { TaskOutcome, TaskRegistry } from "./task-protocol.ts"

/**
 * R-A1 (A-plan) 輸入接納契約 —— 本計畫（R-D2）消費的單一輸入接納面。
 *
 * A 區已落地（core-agent `SessionExecutorRegistry` / `SessionExecutor.submit`），
 * 所以主機端（run.ts T8）以「薄 adapter」實現此介面：admit =
 * registry.get(sessionId).submit({ tier: "inject", text, description, scope: "turn" })
 * （inject → delivery steer + intent system + synthetic marker，模型經 step
 * boundary 立刻可見、隨身帶 description），wake = no-op —— A 的 executor 是
 * event-driven（任何 admission 在 idle 時都會啟動 idle drain），無需再喚醒。
 * 未注入（undefined）= durable-only 交付（fail-closed，通知停 pending 不回退）。
 */
export interface ParentInputAdmission {
  admit(input: { sessionId: string; text: string; description: string }): Promise<void>
  wake(sessionId: string): void
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
  tasks: TaskRegistry
  admit: ParentInputAdmission | undefined
  // R-D3: 父 session 本身已被取消（cancelTree root chain）→ 不交付（opencode suppress）。
  isSessionCancelled?: (sessionId: string) => boolean
}

export function createNotificationDrain(opts: NotificationDrainOptions): { drain: () => Promise<number> } {
  const isCancelled = opts.isSessionCancelled ?? (() => false)
  return {
    // Idempotent: pending|error|(delivered && !woken) are the only candidates;
    // every transition re-checks the row's current status so a coalesced drain
    // cannot double-admit. Single-threaded per mount; the coordinator doc lease
    // covers cross-process (M23) for the underlying write.
    async drain(): Promise<number> {
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
          await opts.admit.admit({
            sessionId: n.parentSessionId,
            text: renderTaskNotification(n.state, n.submissionId, n.description, n.text),
            description: n.description,
          })
          opts.tasks.updateNotification(n.id, { status: "delivered", timeDelivered: Date.now(), error: undefined })
          opts.tasks.updateNotification(n.id, { status: "woken", timeWoken: Date.now(), error: undefined })
          opts.admit.wake(n.parentSessionId)
          delivered += 1
        } catch (err) {
          opts.tasks.updateNotification(n.id, { status: "error", error: err instanceof Error ? err.message : String(err) })
        }
      }
      // ADAPTATION (M26-D1, plan §written "await save()" unconditionally): a
      // cold-restore drain over an EMPTY outbox would mint an empty
      // `task-<stateId>` doc on every mount — two pre-existing CLI tests
      // assert exactly one *.jsonl per store dir. Save only when a row moved.
      if (changed) await opts.tasks.save()
      return delivered
    },
  }
}
