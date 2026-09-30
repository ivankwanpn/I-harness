import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  expect(settings.resolve()).toMatchObject({ id: "auto", command: "C:\\Program Files\\Git\\bin\\bash.exe", dialect: "posix" })
  const next = await settings.configure({ shell: "pwsh" })
  expect(next).toMatchObject({ selected: "pwsh", resolved: { command: "D:\\PowerShell\\pwsh.exe", dialect: "powershell" } })
  const saved = JSON.parse(await readFile(path, "utf8"))
  expect(saved).toMatchObject({ agentShell: "pwsh", compaction: { auto: false } })
  saved.agentShell = "cmd"
  await writeFile(path, JSON.stringify(saved))
  expect(settings.resolve()).toMatchObject({ id: "cmd", dialect: "cmd" })
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
