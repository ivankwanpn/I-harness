import type { ExecutionSettlement } from "@i-harness/sandbox"
import type { ExecutionSupervisor, SupervisedExecution } from "../execution-supervisor.ts"
import type { ExecCommand, ExecServiceOptions, ExecStreamRunOptions, ExecTransportRequest } from "../index.ts"
import type { Capture, Channel, StreamMetadata } from "./contracts.ts"
import { validateInput } from "./input.ts"
import { createCaptureRetention } from "./retention.ts"
import { completeCapture } from "./completion.ts"

function isEpipe(cause: unknown): boolean { return (cause as NodeJS.ErrnoException)?.code === "EPIPE" }

export function createCaptureFactory(options: ExecServiceOptions, supervisor: ExecutionSupervisor, launchTransport: (request: ExecTransportRequest, automaticPromotion?: boolean) => Promise<SupervisedExecution>) {
  function makeCapture(command: ExecCommand, optionsForRun?: ExecStreamRunOptions, background = false, promotable = false): Promise<Capture> {
    validateInput(command)
    if (optionsForRun !== undefined) {
      const { maxBytes, onStdout } = optionsForRun.stream
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("stream maxBytes must be a positive safe integer")
      if (typeof onStdout !== "function") throw new Error("stream onStdout must be a function")
      if (optionsForRun.backgroundAfterMs !== undefined) throw new Error("stream cannot be combined with promotion")
    }
    const input = command.inputBytes === undefined ? command.input === undefined ? undefined : Buffer.from(command.input)
      : Buffer.from(command.inputBytes)
    const signal = new AbortController()
    let stop: StreamMetadata["stopReason"] | undefined
    const externalAbort = () => { stop ??= "aborted"; signal.abort("cancelled") }
    command.abortSignal?.addEventListener("abort", externalAbort, { once: true })
    if (command.abortSignal?.aborted) externalAbort()
    let timer: ReturnType<typeof setTimeout> | undefined
    const request: ExecTransportRequest = {
      ...(command.executionTarget === undefined ? {} : { executionTarget: command.executionTarget }),
      argv: [...command.argv], cwd: command.cwd,
      ...(command.env === undefined ? {} : { env: { ...command.env } }),
      transport: "pipe", lifetime: command.executionTarget === "wsl" ? "complete-tree" : background || promotable ? "retain-tree" : "complete-tree",
      argumentEncoding: command.windowsVerbatimArguments ? "cmd-verbatim" : "crt",
      sandbox: command.sandbox, abortSignal: signal.signal,
    }
    const launch = launchTransport(request, promotable && !background && command.executionTarget !== "wsl")
    return launch.then(execution => {
      if (command.timeoutMs !== undefined) timer = setTimeout(() => {
        stop ??= "timeout"; signal.abort("timeout")
      }, command.timeoutMs)
      const { handle } = execution
      const stream = optionsForRun?.stream
      const metadata: StreamMetadata | undefined = stream ? { bytesRead: { stdout: 0, stderr: 0 }, bytesAdmitted: { stdout: 0, stderr: 0 } } : undefined
      const retention = createCaptureRetention(options, stream)
      const { output, finalizeOutput } = retention
      let observerFailure: unknown
      let observerFailed = false
      let discardedAfterStop = 0
      let cancellation: Promise<ExecutionSettlement> | undefined
      let captureStopped = false
      const captureWaiters = new Set<() => void>()
      const stopCapture = () => {
        captureStopped = true
        for (const stop of captureWaiters) stop()
        captureWaiters.clear()
      }
      // Remove the stop subscription after every completed frame/write. Racing
      // each frame against one unresolved promise would retain every old waiter.
      const waitForCapture = <T>(pending: Promise<T>): Promise<T | undefined> => new Promise((resolve, reject) => {
        const stopped = () => resolve(undefined)
        if (captureStopped) stopped()
        else captureWaiters.add(stopped)
        void pending.then(value => { captureWaiters.delete(stopped); resolve(value) }, cause => { captureWaiters.delete(stopped); reject(cause) })
      })
      const iterator = handle.io.output[Symbol.asyncIterator]()
      const iteratorFailures: unknown[] = []
      let iteratorReturn: Promise<unknown> | undefined
      const requestIteratorReturn = (): Promise<unknown> => {
        if (!iteratorReturn) {
          try { iteratorReturn = Promise.resolve(iterator.return?.()) }
          catch (cause) { iteratorReturn = Promise.reject(cause) }
          void iteratorReturn.catch(cause => { iteratorFailures.push(cause) })
        }
        return iteratorReturn
      }
      const askStop = (reason: NonNullable<StreamMetadata["stopReason"]>) => {
        if (stop !== undefined) return
        stop = reason
        metadata && (metadata.stopReason = reason)
        cancellation = supervisor.cancel(execution.id, reason === "output-limit" ? "output-limit" : "cancelled")
        void cancellation.catch(() => {})
      }
      let processingFrame = false
      const consume = (async () => {
        while (!captureStopped) {
          processingFrame = false
          const next = iterator.next()
          const item = await waitForCapture(next)
          if (item === undefined) {
            // A pending native read is still owned by the retained handle. Do
            // not request another frame or treat presentation stop as native EOF.
            break
          }
          if (item.done) break
          processingFrame = true
          const frame = item.value
          if (frame.channel !== "stdout" && frame.channel !== "stderr") throw new Error("Pipe backend returned a PTY output frame")
          const channel: Channel = frame.channel
          const bytes = Buffer.from(frame.data)
          if (metadata) {
            metadata.bytesRead[channel] += bytes.length
            if (stop !== undefined) { discardedAfterStop += bytes.length; continue }
            const remaining = stream!.maxBytes - metadata.bytesAdmitted.stdout - metadata.bytesAdmitted.stderr
            const length = Math.min(remaining, bytes.length)
            if (length > 0) {
              const accepted = Buffer.from(bytes.subarray(0, length))
              metadata.bytesAdmitted[channel] += length
              if (channel === "stderr") retention.pushRaw("stderr", accepted)
              else try { if (stream!.onStdout(accepted) === "stop") askStop("consumer") }
                catch (cause) { observerFailed = true; observerFailure = cause; askStop("consumer") }
            }
            discardedAfterStop += bytes.length - length
            if (length < bytes.length || metadata.bytesAdmitted.stdout + metadata.bytesAdmitted.stderr === stream!.maxBytes) askStop("output-limit")
          } else {
            retention.push(channel, bytes)
          }
        }
      })().catch(async cause => {
        askStop("consumer")
        // for-await closes on body failures, not on rejected next(). Even a
        // body-failure return must release this wait if native settlement fails.
        if (processingFrame && !captureStopped) {
          try { await waitForCapture(requestIteratorReturn()) }
          catch { /* The shared return observer preserves the cleanup cause. */ }
        }
        throw cause
      })
      void consume.catch(() => {})
      const writeInput = (async () => {
        try {
          if (input?.length) for (let offset = 0; offset < input.length; offset += 16_384) {
            if (captureStopped) return
            await waitForCapture(handle.io.write(input.subarray(offset, Math.min(input.length, offset + 16_384))))
          }
          if (captureStopped) return
          await handle.io.endInput()
        } catch (cause) {
          if (!isEpipe(cause)) {
            cancellation = supervisor.cancel(execution.id, "cancelled")
            void cancellation.catch(() => {})
            throw cause
          }
        }
      })()
      void writeInput.catch(() => {})
      const stopFailedCapture = () => {
        stopCapture()
        cancellation ??= supervisor.cancel(execution.id, "cancelled")
        void cancellation.catch(() => {})
        // Async generators may queue return behind next. Request it once,
        // without making failed capture depend on native EOF again.
        void requestIteratorReturn()
      }
      const complete = completeCapture({ execution, handle, metadata, consume, writeInput, output,
        stop: () => stop, isStopped: () => captureStopped, stopFailedCapture, waitForCapture,
        cancellation: () => cancellation, observerFailures: () => observerFailed ? [observerFailure] : [],
        iteratorFailures, discardedAfterStop: () => discardedAfterStop, finalizeOutput,
        releaseCommand() {
          if (timer !== undefined) clearTimeout(timer)
          command.abortSignal?.removeEventListener("abort", externalAbort)
        },
      })
      void complete.catch(() => {})
      return { execution, complete, output, ...(request.executionTarget === "wsl" ? { lifetime: "complete-tree" as const } : {}),
        diagnostics: () => handle.io.diagnostics?.() }
    }, cause => {
      if (timer !== undefined) clearTimeout(timer)
      command.abortSignal?.removeEventListener("abort", externalAbort)
      throw cause
    })
  }

  return makeCapture
}
