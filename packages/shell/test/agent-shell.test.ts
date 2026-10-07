import { expect, it } from "vitest"
import { createShellTools, registerShell, type ResolvedAgentShell } from "../src/index.ts"
import { createContext } from "@i-harness/core-plugin"
import { registerExec } from "@i-harness/exec"
import type { ExecCommand, ExecService } from "@i-harness/exec"
import type { PluginContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"

const unusedTransport = {
  launchTransport: async (): Promise<never> => { throw new Error('unused transport') },
  cancelExecution: async (): Promise<never> => { throw new Error('unused transport') },
  dispose: async (): Promise<void> => {},
}

const bash = { id: "git-bash", label: "Git Bash", command: "D:/Git/bin/bash.exe", dialect: "posix" } as const
const cmd = { id: "cmd", label: "CMD", command: "C:/Windows/System32/cmd.exe", dialect: "cmd" } as const
const pwsh = { id: "pwsh", label: "PowerShell 7", command: "C:/PowerShell/pwsh.exe", dialect: "powershell" } as const
function getAgentArgv(command: string, dialect: ResolvedAgentShell["dialect"]): string[] {
  const selected = dialect === "posix" ? bash : dialect === "cmd" ? cmd : pwsh
  return createShellTools({ exec: recorder().exec, agentShell: () => selected }).find((tool) => tool.name === "shell")!.getArgv!({ command })
}
function recorder() {
  const commands: ExecCommand[] = []
  const exec: ExecService = {
    ...unusedTransport,
    run: async (command) => { commands.push(command); return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false } },
    runBackground: async (command) => { commands.push(command); return { jobId: "job" } },
    getOutput: () => ({ id: "job", status: "running", stdout: "", stderr: "" }),
    killJob: async () => "already-finished", listJobs: () => [],
  }
  return { commands, exec }
}
it("launches subsequent Agent commands using the changed shell and noninteractive dialect flags", async () => {
  const { commands, exec } = recorder()
  let selected: ResolvedAgentShell = bash
  const tool = createShellTools({ exec, agentShell: () => selected, cwd: "D:/workspace" }).find((tool) => tool.name === "shell")
  expect(tool).toBeDefined()
  await tool!.execute({ command: "echo first" }, {})
  selected = cmd
  await tool!.execute({ command: "echo second", background: true }, {})
  selected = pwsh
  await tool!.execute({ command: "Get-Date" }, {})
  expect(commands.map((command) => command.argv)).toEqual([
    ["D:/Git/bin/bash.exe", "-c", "echo first"],
    ["C:/Windows/System32/cmd.exe", "/d", "/s", "/c", '"echo second"'],
    ["C:/PowerShell/pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-Date"],
  ])
  expect(commands.map((command) => command.cwd)).toEqual(["D:/workspace", "D:/workspace", "D:/workspace"])
})
it("executes the shell approved for that call when the preference changes during approval", async () => {
  const { commands, exec } = recorder()
  let selected: ResolvedAgentShell = pwsh
  const tool = createShellTools({ exec, agentShell: () => selected }).find((tool) => tool.name === "shell")!
  expect(tool).toBeDefined()
  const args = { command: 'Remove-Item "C:\\outside\\data" -Force' }
  expect(tool.getArgv!(args)).toEqual(["Remove-Item", "C:\\outside\\data", "-Force"])
  selected = bash
  await tool.execute(args, {})
  expect(commands[0]!.argv[0]).toBe("C:/PowerShell/pwsh.exe")
  await tool.execute({ command: "echo next" }, {})
  expect(commands[1]!.argv[0]).toBe("D:/Git/bin/bash.exe")
})
it("returns a legible refusal when the selected executable is unavailable", async () => {
  const { commands, exec } = recorder()
  const tool = createShellTools({ exec, agentShell: () => { throw new Error("Agent Shell 'pwsh' is unavailable") } }).find((tool) => tool.name === "shell")!
  expect(tool).toBeDefined()
  expect(await tool.execute({ command: "Get-Date" }, {})).toMatchObject({ exitCode: -1, stderr: expect.stringMatching(/pwsh.*unavailable/) })
  expect(commands).toEqual([])
})
it("registerShell forwards the live Agent shell resolver", async () => {
  const { commands, exec } = recorder()
  const tools: Tool[] = []
  const ctx = { services: { register: () => {}, get: () => exec }, on: () => () => {} } as unknown as PluginContext
  registerShell(ctx, { register: (tool) => tools.push(tool) }, { agentShell: () => cmd })
  const tool = tools.find((tool) => tool.name === "shell")
  expect(tool).toBeDefined()
  await tool!.execute({ command: "echo selected" }, {})
  expect(commands[0]!.argv).toEqual(["C:/Windows/System32/cmd.exe", "/d", "/s", "/c", '"echo selected"'])
})
it("pins the selected executable before a call waits for approval in any policy mode", async () => {
  const { commands, exec } = recorder()
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  let selected: ResolvedAgentShell = pwsh
  registerShell(ctx, registry, { agentShell: () => selected })
  // Replace only the external process boundary, preserving real context hooks.
  ctx.services.get<ExecService>("exec/service").run = exec.run
  let begin!: () => void, release!: () => void
  const waiting = new Promise<void>((resolve) => { begin = resolve })
  const approved = new Promise<void>((resolve) => { release = resolve })
  ctx.waterfall("tools/pre-execute", async (call, next) => { begin(); await approved; return next(call) })
  const execution = registry.execute({ name: "shell", args: { command: "Write-Output pinned-shell" } })
  await waiting
  selected = bash
  release()
  const result = await execution
  expect(result.output).toMatchObject({ exitCode: 0 })
  expect(commands[0]!.argv[0]).toBe("C:/PowerShell/pwsh.exe")
})
it("preserves Windows paths for approval and keeps dynamic shell syntax conservative", () => {
  expect(getAgentArgv('del /f "C:\\outside\\file.txt"', "cmd")).toEqual(["del", "/f", "C:\\outside\\file.txt"])
  expect(getAgentArgv('Remove-Item -LiteralPath "C:\\outside\\file.txt" -Force', "powershell")).toEqual(["Remove-Item", "-LiteralPath", "C:\\outside\\file.txt", "-Force"])
  expect(getAgentArgv("echo %DYNAMIC_COMMAND%", "cmd")).toContain(";")
  expect(getAgentArgv("& $env:DYNAMIC_COMMAND", "powershell")).toContain(";")
})
it.skipIf(process.platform !== "win32")("executes a quoted CMD command against the real process launcher", async () => {
  const ctx = createContext()
  const exec = registerExec(ctx)
  const tool = createShellTools({ exec, agentShell: () => ({ ...cmd, command: process.env.ComSpec ?? cmd.command }) }).find((tool) => tool.name === "shell")!
  const result = await tool.execute({ command: `"${process.execPath}" -e "process.stdout.write('agent-shell-ok')"` }, {}) as { stdout: string; stderr: string; exitCode: number }
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe("agent-shell-ok")
})
