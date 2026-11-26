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
  const probes: string[] = []
  const installed = new Set(["C:/Program Files/Git/bin/bash.exe", "C:/Windows/System32/cmd.exe", "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "D:/PowerShell/pwsh.exe"])
  const settings = createAgentShellSettings(path, { platform: "win32", env: { SystemRoot: "C:\\Windows", PATH: "D:\\PowerShell" }, exists(candidate) {
    const command = candidate.replaceAll("\\", "/")
    probes.push(command)
    return installed.has(command)
  } })
  return { settings, path, installed, probes }
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
it("resolves the selected Agent shell through only its required probes and keeps the full UI profiles", async () => {
  const { settings, path, probes, installed } = await fixture()
  const { validate, ...automatic } = settings.resolve()
  const pwsh = "D:/PowerShell/pwsh.exe"
  expect(new Set(probes)).toEqual(new Set([pwsh]))
  expect(automatic).toEqual({ id: "auto", label: "自動選擇（主機）", command: "D:\\PowerShell\\pwsh.exe", dialect: "powershell", executionTarget: "host" })

  const catalogue = await settings.state()
  expect(catalogue).toEqual({ executionTarget: "host", selected: "auto", resolved: automatic, options: [
    automatic,
    { id: "git-bash", label: "Git Bash（主機）", command: "C:\\Program Files\\Git\\bin\\bash.exe", dialect: "posix", executionTarget: "host" },
    { id: "pwsh", label: "PowerShell 7（主機）", command: "D:\\PowerShell\\pwsh.exe", dialect: "powershell", executionTarget: "host" },
    { id: "powershell", label: "Windows PowerShell（主機）", command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", dialect: "powershell", executionTarget: "host" },
    { id: "cmd", label: "CMD（主機）", command: "C:\\Windows\\System32\\cmd.exe", dialect: "cmd", executionTarget: "host" },
  ] })

  const cmd = "C:/Windows/System32/cmd.exe"
  await writeFile(path, JSON.stringify({ agentShell: "cmd" }))
  probes.length = 0
  const { validate: validateCmd, ...explicit } = settings.resolve()
  expect(new Set(probes)).toEqual(new Set([cmd]))
  expect(explicit).toEqual(catalogue.options.at(-1))
  expect(validateCmd).not.toThrow()

  // A captured request keeps its executable and refuses if it vanishes.
  installed.delete(pwsh)
  probes.length = 0
  expect(validate).toThrow(/auto.*unavailable/i)
  expect(probes).toEqual([pwsh])
})
it("preserves Terminal Auto eligibility for a nonstandard Windows ComSpec", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-shell-comspec-")); roots.push(root)
  const path = join(root, "settings.json")
  const custom = "D:\\Shell\\custom.exe", pwsh = "D:\\PowerShell\\pwsh.exe"
  const installed = new Set([custom, pwsh])
  const settings = createAgentShellSettings(path, { platform: "win32", env: { ComSpec: custom, PATH: "D:\\PowerShell" }, exists: file => installed.has(file) })
  expect(() => settings.resolve()).toThrow(/auto.*unavailable/i)
  await expect(settings.state()).resolves.toMatchObject({ selected: "auto", options: [expect.objectContaining({ id: "pwsh" })], error: expect.stringMatching(/auto.*unavailable/i) })
  installed.delete(custom)
  expect(settings.resolve()).toMatchObject({ id: "auto", command: pwsh })
  await expect(settings.state()).resolves.toMatchObject({ selected: "auto", resolved: { id: "auto", command: pwsh } })
})
it("keeps PATH Bash distinct from the Git Bash discovered beside Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-shell-path-bash-")); roots.push(root)
  const path = join(root, "settings.json")
  const env = { PATH: "D:\\Git\\cmd;D:\\Git\\bin;D:\\Bash\\bin" }
  const installed = new Set(["D:\\Git\\cmd\\git.exe", "D:\\Git\\bin\\bash.exe", "D:\\Bash\\bin\\bash.exe"])
  const settings = createAgentShellSettings(path, { platform: "win32", env, exists: file => installed.has(file) })
  await writeFile(path, JSON.stringify({ agentShell: "git-bash" }))
  expect(settings.resolve()).toMatchObject({ id: "git-bash", command: "D:\\Git\\bin\\bash.exe" })

  await writeFile(path, JSON.stringify({ agentShell: "bash" }))
  expect(() => settings.resolve()).toThrow(/bash.*unavailable/i)
  expect((await settings.state()).options.map(option => option.id)).toEqual(["git-bash"])

  env.PATH = "D:\\Bash\\bin;D:\\Git\\cmd;D:\\Git\\bin"
  expect(settings.resolve()).toMatchObject({ id: "bash", command: "D:\\Bash\\bin\\bash.exe" })
  expect((await settings.state()).options.map(option => option.id)).toEqual(["git-bash", "bash"])
})
it("uses only the selected POSIX lookup and keeps the settings catalogue ordered", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-shell-posix-")); roots.push(root)
  const path = join(root, "settings.json"), probes: string[] = []
  const settings = createAgentShellSettings(path, { platform: "linux", env: { SHELL: "/bin/bash", PATH: "/bin" }, exists(file) {
    probes.push(file)
    return ["/bin/bash", "/bin/zsh", "/bin/sh"].includes(file)
  } })
  await writeFile(path, JSON.stringify({ agentShell: "zsh" }))
  const { validate, ...selected } = settings.resolve()
  expect(new Set(probes)).toEqual(new Set(["/bin/zsh"]))
  expect(validate).not.toThrow()
  const catalogue = await settings.state()
  expect(catalogue.options.map(option => option.id)).toEqual(["auto", "bash", "zsh", "sh"])
  expect(catalogue.resolved).toEqual(selected)
})
it("keeps an execution alias explicit while auto selects a native Windows executable", async () => {
  const root=await mkdtemp(join(tmpdir(),"ih-agent-shell-native-"));roots.push(root)
  const path=join(root,"settings.json")
  const settings=createAgentShellSettings(path,{platform:"win32",env:{LOCALAPPDATA:"C:\\Users\\fixture\\AppData\\Local",SystemRoot:"C:\\Windows",PATH:"C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WindowsApps"},exists:p=>/WindowsApps[\\/]pwsh.exe$|WindowsPowerShell[\\/]v1.0[\\/]powershell.exe$|System32[\\/]cmd.exe$/i.test(p)})
  expect(settings.resolve()).toMatchObject({id:"auto",command:"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",dialect:"powershell"})
  await settings.configure({shell:"pwsh"})
  expect(settings.resolve().command).toMatch(/WindowsApps[\\/]pwsh.exe$/)
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
it.skipIf(!hasNativeAlias)("refuses a launchable but inaccessible PowerShell alias before selecting a command", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-shell-alias-")); roots.push(root)
  const settings = createAgentShellSettings(join(root, "settings.json"), { env: { Path: win32.dirname(nativeAlias), SystemRoot: process.env.SystemRoot }, platform: "win32" })
  await expect(settings.configure({ shell: "pwsh" })).rejects.toThrow(/pwsh.*unavailable/i)
  expect((await settings.state()).options.some(option => option.id === "pwsh")).toBe(false)
  const selected = settings.resolve()
  expect(selected).toMatchObject({ id: "auto", dialect: "powershell" })
  expect(selected.command).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i)
  expect(() => selected.validate()).not.toThrow()
  const tools: Tool[] = []
  registerShell(createContext(), { register: (tool) => tools.push(tool) }, { agentShell: () => selected, cwd: root })
  const tool = tools.find((tool) => tool.name === "shell")!
  const output = await tool.execute({ command: "$PSVersionTable.PSVersion.Major" }, {})
  expect(output).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/\b5\b/) })
}, 15000)
