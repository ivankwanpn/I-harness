import type { PromotedRun } from "@i-harness/exec"

/**
 * W10: exec handed a FOREGROUND command back as a job because it outlived the
 * promotion threshold. The result must say exactly that, because the one thing
 * it must never look like is a choice the model made: a bare `{ job_id }` is
 * what the model's OWN `background: true` call returns, so on that shape it
 * would believe it had asked for background. `promoted: true` plus the elapsed
 * time is the difference, and `stdout` states it in words as well — that is
 * the field the model reads first.
 *
 * The partial output is deliberately NOT repeated here. It is not lost: it is
 * already in the job record this id names (the same record `job_output` reads),
 * and copying it into the tool result would show the model a snapshot frozen at
 * the hand-back while the job keeps writing.
 */
export function promotedResult(
  promoted: PromotedRun,
  tool: "bash" | "pwsh" | "shell",
  deadlineMs: number | undefined,
): { stdout: string; job_id: string; promoted: true; ran_foreground_ms: number } {
  // The deadline is named only when the host declared one: a mount without
  // `timeoutMs` has no deadline to explain, and quoting 120_000 here would be
  // asserting a number this layer never saw.
  const why = deadlineMs === undefined
    ? ""
    : ` A foreground ${tool} call is killed at ${deadlineMs}ms and its work is lost, so the harness promotes instead of waiting for that.`
  return {
    job_id: promoted.jobId,
    promoted: true,
    ran_foreground_ms: promoted.ranForegroundMs,
    stdout:
      promoted.promotionReason === "user-steer"
      ? `Yielded to new user input; command continues as job ${promoted.jobId}. Read its output with job_output({ job_id: "${promoted.jobId}" }); job_list lists it, job_kill stops it.`
      :
      `[i-harness] the ${tool} command was still running after ${promoted.ranForegroundMs}ms, so the harness promoted it to background job ` +
      `${promoted.jobId} and returned this id instead of waiting. You did NOT ask for background — the harness did.${why} ` +
      `The command is STILL RUNNING. Read its output with job_output({ job_id: "${promoted.jobId}" }); job_list lists it, job_kill stops it.`,
  }
}
