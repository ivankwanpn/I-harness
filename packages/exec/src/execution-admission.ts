import { checkBackendRequirements } from "@i-harness/sandbox"
import type {
  BackendRequirements, CompiledSandboxPolicy, ExecutionBackend, ExecutionHandle, ProcessSpec,
} from "@i-harness/sandbox"

class ExecutionAdmissionError extends Error {
  readonly missing: readonly string[]
  constructor(missing: readonly string[]) {
    super(`Execution admission refused: missing backend requirements: ${missing.join(", ")}`)
    this.name = "ExecutionAdmissionError"
    this.missing = Object.freeze([...missing])
  }
}

/**
 * Admit one execution through a supplied backend. The backend owns partial
 * preparation failures and must invoke the callback at its final launch fence.
 * Successful commit transfers ownership to the returned handle; every failure
 * after preparation rolls back before rejection, preserving cleanup failures.
 */
export async function launchExecution({ backend, spec, policy, requirements, validateAuthority, signal }: {
  backend: ExecutionBackend
  spec: ProcessSpec
  policy: CompiledSandboxPolicy
  requirements: BackendRequirements
  validateAuthority(policy: CompiledSandboxPolicy): void
  signal?: AbortSignal
}): Promise<ExecutionHandle> {
  function checkAbort(): void {
    if (signal?.aborted) {
      const error = new Error("Execution admission aborted", { cause: signal.reason })
      error.name = "AbortError"
      throw error
    }
  }
  function revalidate(): void {
    checkAbort()
    validateAuthority(policy)
  }

  revalidate()
  const decision = checkBackendRequirements(await backend.probe(), requirements)
  if (!decision.ok) throw new ExecutionAdmissionError(decision.missing)
  checkAbort()
  const prepared = await backend.prepare(spec, policy, signal)
  try {
    revalidate()
    return await prepared.commit(revalidate)
  } catch (cause) {
    try { await prepared.rollback() }
    catch (rollbackCause) {
      throw new AggregateError([cause, rollbackCause], "Execution admission failed and rollback failed", { cause })
    }
    throw cause
  }
}
