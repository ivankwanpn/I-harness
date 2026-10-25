import { RecipientDeliveryRecoveryError } from '../lifecycle/recipient-delivery.ts'
import { DeliverySourcesError, OriginalTerminalRecoveryError } from '../../../subagent/src/task-notification.ts'

export const isRetryableDeliveryError = (error: unknown): boolean => error instanceof RecipientDeliveryRecoveryError && error.deliveryDisposition.kind === 'retryable'
  || error instanceof OriginalTerminalRecoveryError || error instanceof DeliverySourcesError && error.retryable

/** Scheduling only. Original captures, Inbox and the existing serial lane own
 * the work; this loop has no model executor or persistent state of its own. */
export function createDeliveryDrain(options: {
  current(): boolean
  reconcile(): Promise<void>
  pending(): readonly string[]
  schedule(inputId: string): boolean
  report(error: unknown): void
}) {
  let dirty = false, retired = false, running: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, backoff = 0
  const attempted = new Set<string>()
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const run = (): Promise<void> => {
    if (running) return running
    const pending = (async () => {
      while (dirty && !retired && options.current()) {
        dirty = false
        let failure: unknown
        try { await options.reconcile() } catch (error) { failure = error; options.report(error) }
        if (retired || !options.current()) return
        // Source failure cannot erase already committed eligible inputs. The
        // actual owner readiness still gates registration on the normal lane.
        for (const inputId of options.pending()) {
          if (retired || !options.current()) return
          if (attempted.has(inputId)) continue
          try { if (options.schedule(inputId)) attempted.add(inputId) } catch (error) { options.report(error); failure ??= error }
        }
        if (failure) {
          // A blocked observation never dirties itself. Actual source/receiver
          // changes may trigger one new pass under the same published owner.
          if (!dirty && !retired && options.current() && isRetryableDeliveryError(failure) && timer === undefined) {
            const delay = [100, 500, 2000, 5000][Math.min(backoff++, 3)]!
            timer = setTimeout(() => { timer = undefined; dirty = true; void run() }, delay)
          }
        } else { clear(); backoff = 0 }
      }
    })()
    running = pending
    void pending.then(() => { running = undefined; if (dirty && !retired && options.current()) void run() }, () => { running = undefined })
    return pending
  }
  return {
    signal() { if (retired) return; clear(); dirty = true; void run() },
    reconcile() { if (retired) return Promise.resolve(); clear(); dirty = true; return run() },
    retire() { retired = true; dirty = false; clear() },
    join() { return running ?? Promise.resolve() },
  }
}
