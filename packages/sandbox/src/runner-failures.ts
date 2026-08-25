import type { RunnerFailureRule } from "./index.ts"

export interface ShellLikeResult {
  exitCode: number
  stderr: { text: string }
}

export function matchesSignature(line: string, signature: string): boolean {
  return line.toLowerCase().includes(signature.toLowerCase())
}

// M16 final-review (I3): the runner-failure classifier lives in the SEAM so
// @i-harness/exec can consume it without depending on a platform backend
// package (exec → sandbox-local → sandbox would still be acyclic, but exec is
// generic and must not import the local backend). sandbox-local re-exports it.
export function classifyRunnerFailure(
  result: ShellLikeResult,
  rules: readonly RunnerFailureRule[],
): { detail: string } | undefined {
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(result.exitCode)) continue
    const lines = result.stderr.text.split("\n")
    for (const line of lines) {
      if (rule.informationalLines?.some((i) => line.trim().toLowerCase() === i.toLowerCase())) continue
      if (rule.fatalSignatures.some((s) => matchesSignature(line, s))) return { detail: line }
    }
  }
  return undefined
}
