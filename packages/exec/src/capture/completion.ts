import type { ExecutionSettlement, RootExit, TerminationObservation, TransportExecutionHandle } from "@i-harness/sandbox"
import type { ResultExecution } from '@i-harness/core-session'
import { SandboxUnavailableError, classifyRunnerFailure } from "@i-harness/sandbox"
import { execOutputReader, registerRetainedOutput, registerExecResultOutcome } from "../retained-output.ts"
import type { ExecResult } from "../index.ts"
import type { Capture, StreamMetadata } from "./contracts.ts"

export function clean(text: string): string { return text.replace(/\r\n/g, "\n") }
function unknownExit(root: RootExit): number { return root.exitCode ?? -1 }

function nativeOutcome(root: RootExit, termination: Readonly<TerminationObservation> | undefined): ResultExecution['outcome'] {
  if (termination?.kind === 'confirmed') {
    return termination.reason === 'timeout' || termination.reason === 'output-limit' ? 'failed' : 'canceled'
  }
  if (termination?.kind !== 'none' || root.observationError !== undefined
    || root.exitCode === null || !Number.isFinite(root.exitCode) || !Number.isInteger(root.exitCode)) return 'unknown'
  return root.exitCode === 0 ? 'succeeded' : 'failed'
}

// Live owner queries preserve reads after awaits; this does not copy capture
// stop, cancellation, failure or output state into another completion owner.
interface CaptureCompletion {
  readonly execution: Capture["execution"]
  readonly handle: TransportExecutionHandle
  readonly metadata: StreamMetadata | undefined
  readonly consume: Promise<void>
  readonly writeInput: Promise<void>
  readonly output: Capture["output"]
  stop(): StreamMetadata["stopReason"] | undefined
  isStopped(): boolean
  stopFailedCapture(): void
  waitForCapture<T>(pending: Promise<T>): Promise<T | undefined>
  cancellation(): Promise<ExecutionSettlement> | undefined
  observerFailures(): unknown[]
  readonly iteratorFailures: readonly unknown[]
  discardedAfterStop(): number
  finalizeOutput(): unknown[]
  releaseCommand(): void
}

/** Join root, tree/resource settlement, output EOF and input independently. */
export async function completeCapture({
  execution, handle, metadata, consume, writeInput, output, stop, isStopped,
  stopFailedCapture, waitForCapture, cancellation, observerFailures,
  iteratorFailures, discardedAfterStop, finalizeOutput, releaseCommand,
}: CaptureCompletion): Promise<ExecResult> {
  let failed = false
  let primary: unknown
  try {
    // Failed native settlement must stop presentation even if the native
    // channel stays open. The supervisor retains that handle for retries.
    const settlement = handle.settled.then(result => {
      if (result.kind !== "settled") stopFailedCapture()
      return result
    }, cause => { stopFailedCapture(); throw cause })
    const outcomes = await Promise.allSettled([
      waitForCapture(handle.rootExited), settlement,
      consume, waitForCapture(writeInput),
    ] as const)
    const failures: unknown[] = observerFailures()
    for (const outcome of outcomes) if (outcome.status === "rejected" && !failures.includes(outcome.reason)) failures.push(outcome.reason)
    if (outcomes[1].status === "fulfilled" && outcomes[1].value.kind !== "settled") {
      failures.push(new Error(`Execution settlement incomplete: ${outcomes[1].value.detail}`))
    }
    // Spill ownership ends with stopped presentation, even if an ongoing
    // native cancellation still needs time to report its cleanup result.
    if (isStopped()) failures.push(...finalizeOutput())
    if (cancellation()) try {
      const cancelled = await cancellation()!
      const initial = outcomes[1]
      if (cancelled.kind === "incomplete" && !(initial.status === "fulfilled" && initial.value.kind === "incomplete"
        && initial.value.phase === cancelled.phase && initial.value.detail === cancelled.detail)) {
        failures.push(new Error(`Execution cancellation incomplete: ${cancelled.detail}`))
      }
    } catch (cause) { if (!failures.includes(cause)) failures.push(cause) }
    for (const cause of iteratorFailures) if (!failures.includes(cause)) failures.push(cause)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "Execution and cleanup failed")
    const root = (outcomes[0] as PromiseFulfilledResult<RootExit>).value
    const outcome = nativeOutcome(root, handle.terminationObservation?.())
    const { stdout: sOut, stderr: sErr } = output()
    const driverDiagnostics = handle.io.diagnostics?.()
    const discardedOutputBytes = discardedAfterStop() + (driverDiagnostics?.discardedOutputBytes ?? 0)
    const result: ExecResult = {
      stdout: metadata ? "" : clean(sOut.text), stderr: clean(sErr.text), exitCode: unknownExit(root), timedOut: stop() === "timeout",
      ...(metadata ? { stream: { ...metadata, ...(stop() === undefined ? {} : { stopReason: stop() }) } } : {}),
      ...(sOut.truncated || sErr.truncated ? { stdoutSpillPath: sOut.spillPath, stderrSpillPath: sErr.spillPath,
        truncated: { stdout: sOut.truncated, stderr: sErr.truncated } } : {}),
      ...(discardedOutputBytes || driverDiagnostics?.outputAbandoned ? { outputDiagnostics: {
        outputAbandoned: driverDiagnostics?.outputAbandoned ?? false, discardedOutputBytes,
      } } : {}),
    }
    registerExecResultOutcome(result, outcome)
    if (!metadata) registerRetainedOutput(result, execOutputReader([sOut, sErr]))
    const runner = handle.runner
    // Advisory only: the stderr bytes are program-controlled, so a match is a
    // hint that the SANDBOX refused the operation (rather than the command
    // failing) — never an authorization or escalation input.
    if (result.exitCode !== 0 && execution.policy.mode !== "danger-full-access") {
      const denied = matchedDenialSignatures(result.stderr, runner?.denialSignatures)
      if (denied.length > 0) result.sandboxDenial = { signatures: denied }
    }
    if (stop() !== "timeout" && result.exitCode !== 0 && runner?.runnerFailureRules.length && execution.policy.mode !== "danger-full-access") {
      const failure = classifyRunnerFailure({ exitCode: result.exitCode, stderr: { text: result.stderr } }, runner.runnerFailureRules)
      if (failure) throw new SandboxUnavailableError(execution.policy.mode, failure.detail, "command-not-run")
    }
    return result
  } catch (cause) {
    failed = true
    primary = cause
    throw cause
  } finally {
    releaseCommand()
    const cleanup = finalizeOutput()
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, "Execution output cleanup failed")
  }
}

/** Case-insensitive line match against the backend's denial vocabulary. */
function matchedDenialSignatures(stderr: string, signatures: readonly string[] | undefined): string[] {
  if (signatures === undefined || signatures.length === 0) return []
  const found: string[] = []
  for (const line of stderr.split("\n")) {
    const lowered = line.toLowerCase()
    for (const signature of signatures) {
      if (!found.includes(signature) && lowered.includes(signature.toLowerCase())) found.push(signature)
    }
  }
  return found.slice(0, 3)
}