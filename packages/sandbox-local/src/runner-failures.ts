import type { RunnerFailureRule } from "@i-harness/sandbox"

export interface ShellLikeResult {
  exitCode: number
  stderr: { text: string }
}

export function isRunnerSpawnFailure(err: unknown, runnerProgram: string, _workdir: string): boolean {
  const e = err as { code?: string; path?: string; syscall?: string }
  if (e?.code !== "ENOENT" && e?.code !== "EACCES") return false
  if (e.path === runnerProgram && e.syscall === "spawn") return true
  if (e.path === undefined && e.syscall === `spawn ${runnerProgram}`) return true
  return false
}

export function matchesSignature(line: string, signature: string): boolean {
  return line.toLowerCase().includes(signature.toLowerCase())
}

export function classifyDenial(result: ShellLikeResult, denialSignatures: readonly string[]): boolean {
  const lines = result.stderr.text.split("\n")
  for (const line of lines) {
    if (denialSignatures.some((s) => matchesSignature(line, s))) return true
  }
  return false
}

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
