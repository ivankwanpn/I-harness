import type { ExecCommand, ExecResult, ExecRunOptions, ExecStreamRunOptions, PromotedRun } from "../index.ts"
import type { Capture } from "../capture/contracts.ts"
import { validateInput } from "../capture/input.ts"

interface JobObservation {
  makeCapture(command: ExecCommand, optionsForRun?: ExecStreamRunOptions, background?: boolean, promotable?: boolean): Promise<Capture>
  registerJob(capture: Capture): string
  isDisposed(): boolean
}

/** Promotion changes observation of one capture; it never launches again. */
export function createJobObservation({ makeCapture, registerJob, isDisposed }: JobObservation) {
  async function run(command: ExecCommand, runOptions?: ExecRunOptions | ExecStreamRunOptions): Promise<ExecResult | PromotedRun> {
    validateInput(command)
    if (runOptions && "stream" in runOptions && (runOptions.backgroundAfterMs !== undefined || runOptions.promotionWake !== undefined)) throw new Error("stream cannot be combined with promotion")
    if (runOptions && "stream" in runOptions) {
      if (!Number.isSafeInteger(runOptions.stream.maxBytes) || runOptions.stream.maxBytes <= 0) throw new Error("stream maxBytes must be a positive safe integer")
      if (typeof runOptions.stream.onStdout !== "function") throw new Error("stream onStdout must be a function")
    }
    if (command.abortSignal?.aborted) {
      const metadata = runOptions && "stream" in runOptions
        ? { stream: { bytesRead: { stdout: 0, stderr: 0 }, bytesAdmitted: { stdout: 0, stderr: 0 }, stopReason: "aborted" as const } } : {}
      return { stdout: "", stderr: "", exitCode: -1, timedOut: false, ...metadata }
    }
    const streaming = runOptions && "stream" in runOptions ? runOptions : undefined
    const threshold = runOptions && "backgroundAfterMs" in runOptions ? runOptions.backgroundAfterMs : undefined
    const wake = runOptions?.promotionWake
    const capture = await makeCapture(command, streaming, false, threshold !== undefined)
    if (threshold === undefined && wake === undefined) return capture.complete
    const started = Date.now()
    return new Promise<ExecResult | PromotedRun>((resolve, reject) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe: (() => void) | undefined
      const finish = (outcome: { result: ExecResult } | { reason: "deadline" | "user-steer" } | { error: unknown }) => {
        if (finished) return
        // Stop/dispose still owns cancellation and capture settlement. A steer
        // queued in the same stack must not report that cancelled work continues.
        if ("reason" in outcome && (command.abortSignal?.aborted || isDisposed())) return
        finished = true
        const errors: unknown[] = "error" in outcome ? [outcome.error] : []
        if (timer !== undefined) clearTimeout(timer)
        try { unsubscribe?.() } catch (error) { errors.push(error) }
        unsubscribe = undefined
        if (errors.length) { reject(errors.length === 1 ? errors[0] : new AggregateError(errors, "Execution observation failed")); return }
        if ("result" in outcome) resolve(outcome.result)
        else if ("reason" in outcome) resolve({ jobId: registerJob(capture), promoted: true, ranForegroundMs: Date.now() - started, promotionReason: outcome.reason })
      }
      // Register capture settlement first. Deferring promotion one microtask
      // gives an already-published completion precedence and lets synchronous
      // subscribe callbacks return their disposer before observation cleanup.
      void capture.complete.then(result => finish({ result }), error => finish({ error }))
      const checkWake = () => {
        if (finished) return
        try { if (wake?.pending()) queueMicrotask(() => finish({ reason: "user-steer" })) }
        catch (error) { queueMicrotask(() => finish({ error })) }
      }
      try {
        if (wake) unsubscribe = wake.subscribe(checkWake)
        if (threshold !== undefined) timer = setTimeout(() => {
          try { finish({ reason: wake?.pending() ? "user-steer" : "deadline" }) }
          catch (error) { finish({ error }) }
        }, threshold)
        checkWake()
      } catch (error) { finish({ error }) }
    })
  }

  return run
}
