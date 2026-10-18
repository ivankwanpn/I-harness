import type { BackgroundJobView } from "../index.ts"
import type { Job } from "./contracts.ts"
import { clean } from "../capture/completion.ts"
import { execOutputReader, registerRetainedOutput } from "../retained-output.ts"

export function view(job: Job): BackgroundJobView {
  const { stdout, stderr } = job.capture.output()
  const receipt = job.capture.execution.handle.receipt
  const result: BackgroundJobView = {
    id: job.id, status: job.status, stdout: clean(stdout.text), stderr: clean(job.failure ?? stderr.text),
    ...(job.capture.lifetime === undefined ? {} : { lifetime: job.capture.lifetime }),
    ...(stdout.truncated || stderr.truncated ? { stdoutSpillPath: stdout.spillPath, stderrSpillPath: stderr.spillPath,
      truncated: { stdout: stdout.truncated, stderr: stderr.truncated } } : {}),
    owner: job.owner.sessionId, ...(job.owner.parentSessionId === undefined ? {} : { parentSessionId: job.owner.parentSessionId }),
    receipt: { ...receipt, owner: { ...receipt.owner } },
    ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
    ...(job.root === undefined ? {} : { root: { ...job.root } }),
    ...(job.settlement === undefined ? {} : { settlement: job.settlement.kind === "settled"
      ? { ...job.settlement, root: { ...job.settlement.root } } : { ...job.settlement } }),
    ...(job.cleanupDetail === undefined ? {} : { cleanupDetail: job.cleanupDetail }),
    ...(job.capture.diagnostics() === undefined ? {} : { outputDiagnostics: job.capture.diagnostics() }),
  }
  registerRetainedOutput(result, execOutputReader([stdout, stderr]))
  return result
}
