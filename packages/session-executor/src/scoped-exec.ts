import type { ExecCommand, ExecResult, ExecService, PromotedRun } from "@i-harness/exec"
import type { SandboxExecutionPolicy } from "@i-harness/sandbox"

/** Background/search consumers share live standing policy. A tool that already
 * resolved approval carries its own snapshot, which this adapter preserves. */
export function createScopedExec(base: ExecService, cwd: string, policy: () => SandboxExecutionPolicy | undefined): ExecService {
  const commandFor = (command: ExecCommand): ExecCommand => ({ ...command, cwd: command.cwd ?? cwd, sandbox: command.sandbox ?? policy() })
  function run(command: ExecCommand): Promise<ExecResult>
  function run(command: ExecCommand, options: Parameters<ExecService["run"]>[1]): Promise<ExecResult | PromotedRun>
  function run(command: ExecCommand, options?: Parameters<ExecService["run"]>[1]): Promise<ExecResult | PromotedRun> {
    return options === undefined ? base.run(commandFor(command)) : base.run(commandFor(command), options)
  }
  return { ...base, run, runBackground: (command) => base.runBackground(commandFor(command)) }
}
