import type { ExecutionSettlement, TransportExecutionHandle } from "@i-harness/sandbox"
import type { ExecutionSupervisor, SupervisedExecution } from "../execution-supervisor.ts"
import type { ExecCommand, ExecServiceOptions, ExecStreamRunOptions, ExecTransportRequest, ExecFrameCapture, ExecFrameObservation } from "../index.ts"
import type { Capture, CaptureAttempt, Channel, StreamMetadata } from "./contracts.ts"
import { validateInput } from "./input.ts"
import { createCaptureRetention } from "./retention.ts"
import { completeCapture } from "./completion.ts"

function isEpipe(cause: unknown): boolean { return (cause as NodeJS.ErrnoException)?.code === "EPIPE" }
function together(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, message)
}
interface FrameOwner {
  trackFrames(frames: ExecFrameCapture): void
  settleFrames(frames: ExecFrameCapture): Promise<ExecFrameObservation | undefined>
}

export function createCaptureFactory(options: ExecServiceOptions, supervisor: ExecutionSupervisor,
  launchTransport: (request: ExecTransportRequest, automaticPromotion?: boolean) => Promise<SupervisedExecution>, frameOwner: FrameOwner,
  resultRetention: ExecServiceOptions['resultRetention']) {
  function prepare(command: ExecCommand, optionsForRun?: ExecStreamRunOptions, background = false, promotable = false, delivery?: import('../direct-delivery.ts').OriginalExecDeliveryOwner): CaptureAttempt {
    // No acquisition or caller getters before the registry installs this owner.
    let flight: Promise<Capture> | undefined, cleanupFlight: Promise<void> | undefined
    let execution: SupervisedExecution | undefined, handle: TransportExecutionHandle | undefined
    let nativeSettlement: ExecutionSettlement | undefined
    let failed: { cause: unknown } | undefined, retiring = false, clean = false
    let capture: Capture | undefined, frames: ExecFrameCapture | undefined
    let retention: ReturnType<typeof createCaptureRetention> | undefined
    let externalSignal: AbortSignal | undefined, listenerInstalled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const signal = new AbortController()
    let stop: StreamMetadata["stopReason"] | undefined
    let captureStopped = false, cancellation: Promise<ExecutionSettlement> | undefined
    let iterator: AsyncIterator<import('@i-harness/sandbox').ExecutionOutput> | undefined
    let iteratorReturn: Promise<unknown> | undefined, returnPending = false
    const iteratorFailures: unknown[] = []
    let consume: Promise<void> | undefined, writeInput: Promise<void> | undefined, frameWrite: Promise<void> | undefined
    let declaration: Parameters<ExecFrameCapture['complete']>[0] | undefined
    let declaring: Promise<void> | undefined
    let declarationFailure: { cause: unknown } | undefined
    const captureWaiters = new Set<() => void>()
    const externalAbort = () => { stop ??= "aborted"; signal.abort("cancelled") }
    const releaseCommand = () => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (listenerInstalled) { externalSignal!.removeEventListener("abort", externalAbort); listenerInstalled = false }
    }
    const stopCapture = () => {
      captureStopped = true
      for (const stop of captureWaiters) stop()
      captureWaiters.clear()
    }
    const waitForCapture = <T>(pending: Promise<T>): Promise<T | undefined> => new Promise((resolve, reject) => {
      const stopped = () => resolve(undefined)
      if (captureStopped) stopped()
      else captureWaiters.add(stopped)
      void pending.then(value => { captureWaiters.delete(stopped); resolve(value) }, cause => { captureWaiters.delete(stopped); reject(cause) })
    })
    const cancel = () => {
      if (!execution || cancellation) return
      try { cancellation = supervisor.cancel(execution.id, "cancelled") }
      catch (cause) { cancellation = Promise.reject(cause) }
      void cancellation.catch(() => {})
    }
    const requestIteratorReturn = (): Promise<unknown> | undefined => {
      if (!iterator || iteratorReturn) return iteratorReturn
      returnPending = true
      try { iteratorReturn = Promise.resolve(iterator.return?.()) }
      catch (cause) { iteratorReturn = Promise.reject(cause) }
      void iteratorReturn.then(() => { returnPending = false }, cause => { returnPending = false; iteratorFailures.push(cause) })
      return iteratorReturn
    }
    const stopFailedCapture = () => {
      // Initiate native cancellation before any presentation/native joins.
      cancel()
      stopCapture()
      void requestIteratorReturn()
    }
    const declareFrames = (value: NonNullable<typeof declaration>): Promise<void> => {
      if (!frames || declaration !== undefined) return Promise.resolve()
      if (declaring) return declaring
      const pending = Promise.resolve().then(async () => {
        // An admitted write still belongs to this producer after presentation stops.
        await frameWrite?.catch(() => {})
        if (declarationFailure) throw declarationFailure.cause
        try { frames!.complete(value); declaration = value }
        catch (cause) { declarationFailure = { cause }; throw cause }
      })
      declaring = pending
      void pending.then(() => { declaring = undefined }, () => { declaring = undefined })
      return pending
    }
    async function cleanup(retryNative: boolean): Promise<void> {
      const failures: unknown[] = []
      if (failed) stopFailedCapture()
      try { releaseCommand() } catch (cause) { failures.push(cause) }
      let cancelFailure: { cause: unknown } | undefined
      let cancelled: ExecutionSettlement | undefined
      if (cancellation) try { cancelled = await cancellation } catch (cause) { cancelFailure = { cause } }
      if (failed) {
        // No collector mutation can remain once stopped consume has joined.
        await consume?.catch(() => {})
        await waitForCapture(writeInput ?? Promise.resolve()).catch(() => {})
      } else await capture?.complete.catch(() => {})
      retention?.finalizeOutput()
      failures.push(...(retention?.cleanupFailures() ?? []))
      if (frames) {
        try { await declareFrames('producer-incomplete') } catch (cause) { failures.push(cause) }
        try {
          const result = await frameOwner.settleFrames(frames)
          if (result?.kind !== 'ready') failures.push(new Error('Result retention still requires recovery'))
        } catch (cause) { failures.push(cause) }
      }
      let nativeClean = false
      if (execution && !handle) failures.push(new Error('Original execution handle cleanup is unknown'))
      if (handle) {
        try {
          // Read the original handle again: retry may have replaced settled.
          let settlement: ExecutionSettlement
          let nativePending = false
          try {
            if (cancelFailure) {
              // Failed cancellation cannot make caller rejection depend on a
              // process it failed to stop. A settled original promise can still
              // prove cleanup; pending native work remains owned for disposal.
              const known = await Promise.race([handle.settled, Promise.resolve(undefined)])
              if (!known) { nativePending = true; throw cancelFailure.cause }
              settlement = known
            } else settlement = await handle.settled
          }
          catch (cause) { if (!retryNative || nativePending) throw cause; settlement = await handle.release() }
          // Some injected original handles expose a historical settled promise.
          // Their own release result, never a missing registry row, proves retry.
          if (settlement.kind !== 'settled' && retryNative) settlement = await handle.release()
          nativeClean = settlement.kind === 'settled'
          if(nativeClean)nativeSettlement=settlement
          if (settlement.kind !== 'settled') failures.push(new Error(`Execution cleanup incomplete: ${settlement.detail}`))
        } catch (cause) { failures.push(cause) }
      }
      // Historical failures are superseded only by this same native owner.
      if (!nativeClean && cancelFailure && !failures.includes(cancelFailure.cause)) failures.push(cancelFailure.cause)
      if (!nativeClean && cancelled?.kind === 'incomplete') failures.push(new Error(`Execution cancellation incomplete: ${cancelled.detail}`))
      failures.push(...iteratorFailures)
      if (returnPending) failures.push(new Error('Original output iterator return is unresolved'))
      together(failures, 'Capture cleanup failed')
      clean = true
    }
    function retryCleanup(retryNative = false): Promise<void> {
      if (clean) return Promise.resolve()
      if (cleanupFlight) return cleanupFlight
      const pending = Promise.resolve().then(() => cleanup(retryNative))
      cleanupFlight = pending
      void pending.then(() => { cleanupFlight = undefined }, () => { cleanupFlight = undefined })
      return pending
    }
    async function start(): Promise<Capture> {
      try {
        if (retiring) throw new Error('Exec service disposed')
        if (failed) throw failed.cause
        validateInput(command)
        const stream = optionsForRun?.stream
        if (stream) {
          if (!Number.isSafeInteger(stream.maxBytes) || stream.maxBytes <= 0) throw new Error("stream maxBytes must be a positive safe integer")
          if (typeof stream.onStdout !== "function") throw new Error("stream onStdout must be a function")
          if (optionsForRun!.backgroundAfterMs !== undefined) throw new Error("stream cannot be combined with promotion")
        }
        const input = command.inputBytes === undefined ? command.input === undefined ? undefined : Buffer.from(command.input) : Buffer.from(command.inputBytes)
        externalSignal = command.abortSignal
        if (externalSignal) {
          listenerInstalled = true
          externalSignal.addEventListener("abort", externalAbort, { once: true })
          if (externalSignal.aborted) externalAbort()
        }
        const target = command.executionTarget
        const request: ExecTransportRequest = {
          ...(target === undefined ? {} : { executionTarget: target }), argv: [...command.argv], cwd: command.cwd,
          ...(command.env === undefined ? {} : { env: { ...command.env } }), transport: "pipe",
          lifetime: target === "wsl" ? "complete-tree" : background || promotable ? "retain-tree" : "complete-tree",
          argumentEncoding: command.windowsVerbatimArguments ? "cmd-verbatim" : "crt", sandbox: command.sandbox, abortSignal: signal.signal,
        }
        // This assignment is the FIRST action on launch fulfillment. No handle,
        // command or option getter runs before the original attempt owns it.
        if(delivery)await delivery.admit()
        if(retiring)throw new Error('Exec service disposed')
        delivery?.issued()
        execution = await launchTransport(request, promotable && !background && target !== "wsl")
        if (retiring) throw new Error('Exec service disposed')
        handle = execution.handle
        const timeoutMs = command.timeoutMs
        if (timeoutMs !== undefined) timer = setTimeout(() => { stop ??= "timeout"; signal.abort("timeout") }, timeoutMs)
        const owner = resultRetention
        frames = owner?.begin({ sourceId: `process:${execution.id}`, owner: execution.policy.owner })
        if (frames) frameOwner.trackFrames(frames)
        retention = createCaptureRetention(options, stream, resultRetention)
        retention.initialize()
        const { output, finalizeOutput } = retention
        let frameOrdinal = 0, frameCaptureFailed = false
        const metadata: StreamMetadata | undefined = stream ? { bytesRead: { stdout: 0, stderr: 0 }, bytesAdmitted: { stdout: 0, stderr: 0 } } : undefined
        let observerFailure: unknown, observerFailed = false, discardedAfterStop = 0
        iterator = handle.io.output[Symbol.asyncIterator]()
        const askStop = (reason: NonNullable<StreamMetadata["stopReason"]>) => {
          if (stop !== undefined) return
          stop = reason
          metadata && (metadata.stopReason = reason)
          try { cancellation = supervisor.cancel(execution!.id, reason === "output-limit" ? "output-limit" : "cancelled") }
          catch (cause) { cancellation = Promise.reject(cause) }
          void cancellation.catch(() => {})
        }
        let processingFrame = false
        consume = (async () => {
          while (!captureStopped) {
            processingFrame = false
            const item = await waitForCapture(iterator!.next())
            if (item === undefined || item.done) break
            processingFrame = true
            const frame = item.value
            if (frame.channel !== "stdout" && frame.channel !== "stderr") throw new Error("Pipe backend returned a PTY output frame")
            const channel: Channel = frame.channel, bytes = Buffer.from(frame.data), ordinal = frameOrdinal++
            if (frames && !frameCaptureFailed) {
              for (let offset = 0; offset < bytes.length; offset += 32768) {
                if (captureStopped) break
                try {
                  frameWrite = frames.write({ channel, frame: ordinal, offset, end: offset + 32768 >= bytes.length, bytes: bytes.subarray(offset, Math.min(bytes.length, offset + 32768)) },
                    { continuationAllowed: () => stop === undefined && !captureStopped && !signal.signal.aborted && !externalSignal?.aborted })
                  await frameWrite
                } catch { frameCaptureFailed = true; break }
              }
            }
            if (captureStopped) break
            if (metadata) {
              metadata.bytesRead[channel] += bytes.length
              if (stop !== undefined) { discardedAfterStop += bytes.length; continue }
              const remaining = stream!.maxBytes - metadata.bytesAdmitted.stdout - metadata.bytesAdmitted.stderr
              const length = Math.min(remaining, bytes.length)
              if (length > 0) {
                const accepted = Buffer.from(bytes.subarray(0, length))
                metadata.bytesAdmitted[channel] += length
                if (channel === "stderr") retention!.pushRaw("stderr", accepted)
                else try { if (stream!.onStdout(accepted) === "stop") askStop("consumer") }
                  catch (cause) { observerFailed = true; observerFailure = cause; askStop("consumer") }
              }
              discardedAfterStop += bytes.length - length
              if (length < bytes.length || metadata.bytesAdmitted.stdout + metadata.bytesAdmitted.stderr === stream!.maxBytes) askStop("output-limit")
            } else retention!.push(channel, bytes)
          }
        })().catch(async cause => {
          askStop("consumer")
          if (processingFrame && !captureStopped) {
            try { await waitForCapture(requestIteratorReturn() ?? Promise.resolve()) } catch { /* retained by original return observer */ }
          }
          throw cause
        })
        void consume.catch(() => {})
        writeInput = (async () => {
          try {
            if (input?.length) for (let offset = 0; offset < input.length; offset += 16_384) {
              if (captureStopped) return
              await waitForCapture(handle!.io.write(input.subarray(offset, Math.min(input.length, offset + 16_384))))
            }
            if (captureStopped) return
            await handle!.io.endInput()
          } catch (cause) { if (!isEpipe(cause)) { cancel(); throw cause } }
        })()
        void writeInput.catch(() => {})
        const completing = completeCapture({ execution, handle, metadata, consume, writeInput, output,
          stop: () => stop, isStopped: () => captureStopped, stopFailedCapture, waitForCapture,
          cancellation: () => cancellation, observerFailures: () => [...(observerFailed ? [observerFailure] : []), ...(failed ? [failed.cause] : [])],
          iteratorFailures, discardedAfterStop: () => discardedAfterStop, finalizeOutput, releaseCommand })
        const complete = completing.then(async result => {
          const diagnostics = result.outputDiagnostics
          await declareFrames(frameCaptureFailed || diagnostics?.outputAbandoned || (diagnostics?.discardedOutputBytes ?? 0) > 0 ? 'producer-incomplete' : stop !== undefined || captureStopped ? 'capture-canceled' : 'complete')
          if (!frames) clean = true
          return result
        }, async cause => {
          try { await declareFrames('producer-incomplete') }
          catch (cleanup) { throw new AggregateError([cause, cleanup], 'Execution producer completion failed') }
          throw cause
        })
        void complete.catch(() => {})
        capture = { execution, complete, output, ...(frames ? { frames } : {}), ...(target === "wsl" ? { lifetime: "complete-tree" as const } : {}), diagnostics: () => handle!.io.diagnostics?.() }
        return capture
      } catch (cause) {
        failed = { cause }
        // Read no native handle before attachment; after attachment retain the
        // exact execution even if its handle getter itself failed.
        if (execution && !handle) try { handle = execution.handle } catch { /* original failure remains */ }
        try { await retryCleanup() }
        catch (cleanup) { throw new AggregateError([cause, cleanup], 'Execution setup and cleanup failed') }
        throw cause
      }
    }
    const attempt: CaptureAttempt = Object.freeze({
      disposition(){if(this!==attempt)throw new Error('Invalid capture attempt receiver');return {execution,frames,timedOut:stop==='timeout',settlement:nativeSettlement}},
      start() {
        if (this !== attempt) throw new Error('Invalid capture attempt receiver')
        // Publish flight before any caller getter or reentrant launch callback.
        if (!flight) {
          let resolve!: (value: Capture) => void, reject!: (cause: unknown) => void
          flight = new Promise<Capture>((done, fail) => { resolve = done; reject = fail })
          void start().then(resolve, reject)
        }
        return flight
      },
      async fail(cause: unknown) {
        if (this !== attempt) throw new Error('Invalid capture attempt receiver')
        if (!failed) { failed = { cause }; clean = false; stopFailedCapture() }
        await retryCleanup()
      },
      async retire() {
        if (this !== attempt) throw new Error('Invalid capture attempt receiver')
        retiring = true
        if (!capture) signal.abort('shutdown')
        await flight?.catch(() => {})
        await retryCleanup(true)
      },
      retryCleanup() {
        if (this !== attempt) throw new Error('Invalid capture attempt receiver')
        return retryCleanup()
      },
      isClean() {
        if (this !== attempt) throw new Error('Invalid capture attempt receiver')
        return clean
      },
    })
    return attempt
  }
  const factory = Object.freeze({
    prepare(...args: Parameters<typeof prepare>) {
      if (this !== factory) throw new Error('Invalid capture factory receiver')
      return prepare(...args)
    },
  })
  return factory
}
