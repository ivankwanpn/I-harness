import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, win32 } from "node:path"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createShellTools, registerShell } from "@i-harness/shell"
import type { Tool } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"
import { createAgentShellSettings } from "../src/agent-shell.ts"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-shell-")); roots.push(root)
  const path = join(root, "settings.json")
  const installed = new Set(["C:/Program Files/Git/bin/bash.exe", "C:/Windows/System32/cmd.exe", "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "D:/PowerShell/pwsh.exe"])
  const settings = createAgentShellSettings(path, { platform: "win32", env: { SystemRoot: "C:\\Windows", PATH: "D:\\PowerShell" }, exists: (candidate) => installed.has(candidate.replaceAll("\\", "/")) })
  return { settings, path, installed }
}
it("saves detected Agent shells separately and resolves changed disk preferences for subsequent commands", async () => {
  const { settings, path } = await fixture()
  await writeFile(path, JSON.stringify({ compaction: { auto: false } }))
  expect(settings.resolve()).toMatchObject({ id: "auto", command: "D:\\PowerShell\\pwsh.exe", dialect: "powershell" })
  const next = await settings.configure({ shell: "pwsh" })
  expect(next).toMatchObject({ selected: "pwsh", resolved: { command: "D:\\PowerShell\\pwsh.exe", dialect: "powershell" } })
  const saved = JSON.parse(await readFile(path, "utf8"))
  expect(saved).toMatchObject({ agentShell: "pwsh", compaction: { auto: false } })
  saved.agentShell = "cmd"
  await writeFile(path, JSON.stringify(saved))
  expect(settings.resolve()).toMatchObject({ id: "cmd", dialect: "cmd" })
})
it("prefers detected native Windows shells for Agent auto and falls back in order", async () => {
  const { settings, installed } = await fixture()
  expect(settings.resolve()).toMatchObject({ id: "auto", command: "D:\\PowerShell\\pwsh.exe", dialect: "powershell" })
  installed.delete("D:/PowerShell/pwsh.exe")
  expect(settings.resolve()).toMatchObject({ id: "auto", command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", dialect: "powershell" })
  installed.delete("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
  expect(settings.resolve()).toMatchObject({ id: "auto", command: "C:\\Windows\\System32\\cmd.exe", dialect: "cmd" })
  installed.delete("C:/Windows/System32/cmd.exe")
  expect(() => settings.resolve()).toThrow(/auto.*unavailable/i)
})
it("preserves explicit Git Bash, terminal auto, and non-Windows Agent auto", async () => {
  const { settings, path, installed } = await fixture()
  await expect(settings.state()).resolves.toMatchObject({ options: expect.arrayContaining([expect.objectContaining({ id: "git-bash" })]) })
  await settings.configure({ shell: "git-bash" })
  expect(settings.resolve()).toMatchObject({ id: "git-bash", dialect: "posix" })
  const { listDesktopTerminalShellOptions } = await import("../src/terminal-shells.ts")
  expect(listDesktopTerminalShellOptions({ platform: "win32", env: { SystemRoot: "C:\\Windows", PATH: "D:\\PowerShell" }, exists: (candidate) => installed.has(candidate.replaceAll("\\", "/")) })[0]).toMatchObject({ id: "auto", command: "C:\\Program Files\\Git\\bin\\bash.exe" })
  const unix = createAgentShellSettings(join(dirname(path), "unix-settings.json"), { platform: "linux", env: { SHELL: "/bin/bash", PATH: "/bin" }, exists: (candidate) => candidate === "/bin/bash" })
  expect(unix.resolve()).toMatchObject({ id: "auto", command: "/bin/bash", dialect: "posix" })
})
it("uses the auto-selected native shell in generic shell argv and PowerShell approval tokenization", async () => {
  const { settings } = await fixture()
  const selected = settings.resolve()
  let launched: { argv: string[] } | undefined
  const exec = { run: async (command: { argv: string[] }) => { launched = command; return { stdout: "", stderr: "", exitCode: 0, timedOut: false } }, runBackground: () => ({ jobId: "job" }), getOutput: () => undefined, killJob: () => "already-finished", listJobs: () => [] }
  const tool = createShellTools({ exec: exec as never, agentShell: () => selected }).find((tool) => tool.name === "shell")!
  const args = { command: "Remove-Item -LiteralPath 'C:\\outside\\file.txt' -Force" }
  expect(tool.getArgv!(args)).toEqual(["Remove-Item", "-LiteralPath", "C:\\outside\\file.txt", "-Force"])
  expect(tool.approvalIdentity!(args)).toBeUndefined()
  const result = await tool.execute(args, {})
  expect(result).toMatchObject({ exitCode: 0 })
  expect(launched?.argv).toEqual(["D:\\PowerShell\\pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", args.command])
})
it("refuses missing or arbitrary choices and reports a selected executable that disappears", async () => {
  const { settings, path, installed } = await fixture()
  await settings.configure({ shell: "pwsh" })
  installed.delete("D:/PowerShell/pwsh.exe")
  expect(() => settings.resolve()).toThrow(/pwsh.*unavailable/i)
  expect(await settings.state()).toMatchObject({ selected: "pwsh", error: expect.stringMatching(/unavailable/i) })
  await expect(settings.configure({ shell: "pwsh" })).rejects.toThrow(/unavailable/i)
  await expect(settings.configure({ shell: "D:/untrusted.exe" })).rejects.toThrow(/invalid/i)
  expect(JSON.parse(await readFile(path, "utf8")).agentShell).toBe("pwsh")
})
it("does not silently normalize an invalid on-disk Agent shell to auto", async () => {
  const { settings, path } = await fixture()
  await writeFile(path, JSON.stringify({ agentShell: "surprise" }))
  expect(() => settings.resolve()).toThrow(/invalid.*shell/i)
})

const nativeAlias = win32.join(process.env.LOCALAPPDATA ?? "C:\\missing", "Microsoft", "WindowsApps", "pwsh.exe")
const hasNativeAlias = process.platform === "win32" && !existsSync(nativeAlias)
  && spawnSync(nativeAlias, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true }).stdout?.startsWith("PowerShell 7")
it.skipIf(!hasNativeAlias)("detects and validates a runnable PowerShell alias through the actual Agent Shell settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-shell-alias-")); roots.push(root)
  const settings = createAgentShellSettings(join(root, "settings.json"), { env: { Path: win32.dirname(nativeAlias), SystemRoot: process.env.SystemRoot }, platform: "win32" })
  expect(await settings.configure({ shell: "pwsh" })).toMatchObject({ resolved: { command: nativeAlias, dialect: "powershell" } })
  const selected = settings.resolve()
  expect(() => selected.validate()).not.toThrow()
  const tools: Tool[] = []
  registerShell(createContext(), { register: (tool) => tools.push(tool) }, { agentShell: () => selected, cwd: root })
  const tool = tools.find((tool) => tool.name === "shell")!
  const result = await tool.execute({ command: "$PSVersionTable.PSVersion.Major" }, {}) as { stdout: string; stderr: string; exitCode: number }
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe("7")
}, 15000)
