import type { TaskOutcome, TaskRegistry } from "./task-protocol.ts"
import type { DeliveryAdmissionReceipt, DeliveryLaunchPreparation, InputDisplay, SubagentDeliveryEvidence } from "@i-harness/core-session"
import { boundedNotification, type ReportPolicy } from "./report-policy.ts"
import { originalTaskSaveDependency } from './task/persistence.ts'
import {captureTaskNotificationProgress,type NotificationTaskAccess} from './task/required-settlement.ts'
import { DeliverySuppressedError, DeliverySourcesError } from '@i-harness/core-agent/internal/lifecycle/delivery-errors'
export { DeliverySuppressedError, OriginalTerminalRecoveryError, DeliverySourcesError } from '@i-harness/core-agent/internal/lifecycle/delivery-errors'

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
  taskEvidence?(namespace:string,taskId:string):{evidence:SubagentDeliveryEvidence;expectedInputId:string}|undefined
  prepareTaskDelivery?(input: { sessionId: string; namespace: string; taskId: string; callSeq: number }): Promise<DeliveryLaunchPreparation>
  admitTaskDelivery?(input: { sessionId: string; evidence: SubagentDeliveryEvidence; text: string; description: string; display: InputDisplay }): Promise<DeliveryAdmissionReceipt>
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
  current?:()=>boolean
  reconcileSources?: () => Promise<void>
  evidence?: (taskId: string) => { evidence: SubagentDeliveryEvidence; expectedInputId: string } | undefined
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
    // Pending/error are handoff candidates. A receipt-acknowledged row never
    // owns receiver scheduling or model consumption.
    // every transition re-checks the row's current status so a coalesced drain
    // cannot double-admit. Single-threaded per mount; the coordinator doc lease
    // covers cross-process (M23) for the underlying write.
    drain(): Promise<number> {
      const run = async () => {
        const failures: unknown[] = []
        try { await opts.reconcileSources?.() } catch (error) { failures.push(error) }
        if(opts.current?.()===false){if(failures.length)throw failures[0];return 0}
        if (!opts.admit?.admitTaskDelivery || !opts.evidence) {
          if (failures.length) throw failures[0]
          return 0
        }
        let delivered = 0
        let changed = false
        let notifications:ReturnType<TaskRegistry['notifications']>
        try { notifications=opts.tasks.notifications() } catch(readinessError) {
          if(failures.length){const original=failures.flatMap(error=>error instanceof DeliverySourcesError?[...error.errors]:[error]);throw new DeliverySourcesError([...original,readinessError])}
          throw readinessError
        }
        const candidate=notifications.some(n=>(n.status==='pending'||n.status==='error')&&opts.tasks.get(n.submissionId)?.publication!=='unqualified')
        const progress=candidate?await captureTaskNotificationProgress(opts.tasks):undefined
        const tasks:NotificationTaskAccess=progress?.tasks??opts.tasks
        let failed:{cause:unknown}|undefined
        try{
          for (const n of notifications) {
            if (tasks.get(n.submissionId)?.publication === 'unqualified') continue
            const candidate = n.status === "pending" || n.status === "error"
            if (!candidate) continue
            const handoff = opts.evidence(n.submissionId)
            if (!handoff) continue
            const { evidence, expectedInputId } = handoff
            changed = true
            tasks.updateNotification(n.id, { attempts: n.attempts + 1, ...(n.status === "error" ? { error: undefined } : {}) })
            if (isCancelled(n.parentSessionId)) {
              tasks.updateNotification(n.id, { status: "suppressed", error: "parent session cancelled before notification delivery" })
              continue
            }
            try {
              if (opts.reportPolicy) await tasks.retainResult(n.submissionId)
              // Retention may wait on storage while the parent delegation is
              // cancelled. Its completed child's result cannot authorize a wake.
              if (isCancelled(n.parentSessionId)) {
                tasks.updateNotification(n.id, { status: "suppressed", error: "parent session cancelled before notification delivery" })
                continue
              }
              const task = tasks.get(n.submissionId)
              const reference = `get_task_output({task_ids:[${JSON.stringify(n.submissionId)}]}) (${task?.retention ?? "memory"})`
              let receipt: DeliveryAdmissionReceipt
              try { receipt = await opts.admit.admitTaskDelivery!({
                sessionId: n.parentSessionId,
                evidence,
                text: opts.reportPolicy
                  ? boundedNotification((text, description) => renderTaskNotification(n.state, n.submissionId, description, text), n.text, n.description, reference, opts.reportPolicy)
                  : renderTaskNotification(n.state, n.submissionId, n.description, n.text),
                description: n.description,
                display: { kind: "task", title: `${TASK_REPLY_TITLES[n.state]}: ${n.description}`, body: n.text },
              }) } catch (error) {
                if (!(error instanceof DeliverySuppressedError) || error.inputId !== expectedInputId) throw error
                tasks.updateNotification(n.id, { status: 'suppressed', error: error.message })
                continue
              }
              if (receipt.inputId !== expectedInputId) throw new Error('Recipient acknowledged a different original delivery input')
              if (receipt.disposition === 'suppressed' || receipt.disposition === 'cancelled') {
                tasks.updateNotification(n.id, { status: 'suppressed', error: `receiver ${receipt.disposition}` })
                continue
              }
              tasks.updateNotification(n.id, { status: "delivered", timeDelivered: Date.now(), error: undefined })
              if (receipt.disposition === 'pending') opts.admit.wake(n.parentSessionId)
              delivered += 1
            } catch (err) {
              const stopped = isParentNotificationStopped(err)
              tasks.updateNotification(n.id, { status: stopped ? "suppressed" : "error", error: err instanceof Error ? err.message : String(err) })
              if (!stopped) failures.push(err)
            }
          }
          // ADAPTATION (M26-D1, plan §written "await save()" unconditionally): a
          // cold-restore drain over an EMPTY outbox would mint an empty
          // `task-<stateId>` doc on every mount — two pre-existing CLI tests
          // assert exactly one *.jsonl per store dir. Save only when a row moved.
          // Persist row observations before returning the original retry
          // disposition to the host. Save failure cannot hide receiver debt.
          if (changed) try { await tasks.save() } catch (error) { const original=originalTaskSaveDependency(error);failures.push(original?original.cause:error) }
          if (failures.length === 1) throw failures[0]
          if (failures.length) throw new DeliverySourcesError(failures)
          return delivered
        }catch(cause){failed={cause};throw cause}
        finally{
          try{await progress?.close()}catch(cleanup){if(failed)throw new AggregateError([failed.cause,cleanup],'Task notification and original progress cleanup failed');throw cleanup}
        }
      }
      const pending = drainChain.then(run)
      drainChain = pending.catch(() => 0)
      return pending
    },
  }
}
