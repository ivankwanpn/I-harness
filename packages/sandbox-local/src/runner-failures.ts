// M16 final-review (I3): the classification helpers now live in the SEAM
// (@i-harness/sandbox) so @i-harness/exec can consume them without importing
// a platform backend. sandbox-local re-exports for its own callers/tests.
export {
  classifyRunnerFailure,
  matchesSignature,
  type ShellLikeResult,
} from "@i-harness/sandbox"

// isRunnerSpawnFailure stays local: it is a platform-backend concern (spawn
// error shape of bwrap/etc.), not part of the generic seam.
export function isRunnerSpawnFailure(err: unknown, runnerProgram: string, _workdir: string): boolean {
  const e = err as { code?: string; path?: string; syscall?: string }
  if (e?.code !== "ENOENT" && e?.code !== "EACCES") return false
  if (e.path === runnerProgram && e.syscall === "spawn") return true
  if (e.path === undefined && e.syscall === `spawn ${runnerProgram}`) return true
  return false
}

// classifyDenial stays local too (denial markers are backend vocabulary, not
// part of the generic seam); it reuses the seam's line-matching helper.
import { matchesSignature, type ShellLikeResult } from "@i-harness/sandbox"
export function classifyDenial(result: ShellLikeResult, denialSignatures: readonly string[]): boolean {
  const lines = result.stderr.text.split("\n")
  for (const line of lines) {
    if (denialSignatures.some((s) => matchesSignature(line, s))) return true
  }
  return false
}
