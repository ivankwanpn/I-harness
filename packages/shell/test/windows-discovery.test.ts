import { expect, it } from "vitest"
import { resolveShell, resolvePwshExe, createShellTools } from "../src/index.ts"
import { registerExec } from "@i-harness/exec"
import { createContext } from "@i-harness/core-plugin"
import { existsSync } from "node:fs"
import { win32 } from "node:path"
import { spawnSync } from "node:child_process"

const nativeAlias = win32.join(process.env.LOCALAPPDATA ?? "C:\\missing", "Microsoft", "WindowsApps", "pwsh.exe")
const hasNativeAlias = process.platform === "win32" && !existsSync(nativeAlias)
  && spawnSync(nativeAlias, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true }).stdout?.startsWith("PowerShell 7")
const hasNativeGit = process.platform === "win32" && existsSync(win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"))
const hasNativeNpm = process.platform === "win32" && spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "npm.cmd --version"], { encoding: "utf8", timeout: 3000, windowsHide: true }).status === 0

it("prefers installed Git Bash over Rtools and skips WSL launchers", () => {
  const files = new Set(["C:\\Windows\\System32\\bash.exe", "C:\\rtools44\\usr\\bin\\bash.exe", "C:\\Programs\\Git\\bin\\bash.exe"])
  const env = { Path: "C:\\Windows\\System32;C:\\rtools44\\usr\\bin", ProgramFiles: "C:\\Programs" }
  expect(resolveShell(env, "win32", (path) => files.has(path)).argv[0]).toBe("C:\\Programs\\Git\\bin\\bash.exe")
})

it("returns the absolute PowerShell executable from a case-insensitive quoted Path", () => {
  const exe = "D:\\PowerShell 7\\pwsh.exe"
  expect(resolvePwshExe({ Path: '"D:\\PowerShell 7"' }, "win32", (path) => path === exe)).toBe(exe)
})

it("recognizes a runnable PowerShell 7 App Execution Alias despite a negative exists check", () => {
  const alias = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe"
  expect(resolvePwshExe({ Path: win32.dirname(alias) }, "win32", () => false, (path) => path === alias)).toBe(alias)
})

it.skipIf(!hasNativeGit)("pins the actual Bash on PATH so nested env bash never enters WSL", async () => {
  const exec = registerExec(createContext())
  const tool = createShellTools({ exec })[0]!
  const result = await tool.execute({ command: 'env bash -c \'printf "NESTED-BASH=%s\\n" "$BASH_VERSION"; command -v wslpath || true\'' }, {}) as { stdout: string; stderr: string; exitCode: number }
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toContain("NESTED-BASH=")
  expect(result.stdout).not.toContain("/usr/bin/wslpath")
}, 15000)

it.skipIf(!hasNativeGit || !hasNativeNpm)("runs the installed npm shim through the pinned native Bash", async () => {
  const tool = createShellTools({ exec: registerExec(createContext()) })[0]!
  const result = await tool.execute({ command: "npm --version" }, {}) as { stdout: string; stderr: string; exitCode: number }
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
}, 15000)

it.skipIf(!hasNativeAlias)("refuses an alias the native backend cannot canonicalize", async () => {
  const alias = nativeAlias
  // This host's App Execution Alias is runnable even though Node reports no file.
  expect(existsSync(alias)).toBe(false)
  const exe = resolvePwshExe({ Path: win32.dirname(alias), SystemRoot: process.env.SystemRoot }, "win32")
  await expect(registerExec(createContext()).run({ argv: [exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"] })).rejects.toThrow(/EACCES|realpath|permission denied/i)
}, 15000)
