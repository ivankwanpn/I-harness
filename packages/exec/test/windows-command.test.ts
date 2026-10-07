import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { registerExec } from "../src/index.ts"
import { SandboxUnavailableError, type SandboxProvider } from "@i-harness/sandbox"

it.skipIf(process.platform !== "win32")("preserves CMD command quotes when the caller requests verbatim Windows arguments", async () => {
  const exec = registerExec(createContext())
  const command = `"${process.execPath}" -e "process.stdout.write('verbatim-ok')"`
  const result = await exec.run({ argv: [process.env.ComSpec ?? "C:/Windows/System32/cmd.exe", "/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true })
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toBe("verbatim-ok")
})
it.skipIf(process.platform !== "win32")("does not use an argv-only provider to replace the selected transport backend", async () => {
  const sandbox: SandboxProvider = {
    confine: () => ({ argv: [process.execPath, "-e", "process.stdout.write('wrapped command with spaces')"], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] }),
  }
  const exec = registerExec(createContext(), { sandbox })
  await expect(exec.run({ argv: [process.env.ComSpec ?? "C:/Windows/System32/cmd.exe", "/c", '"ignored"'], windowsVerbatimArguments: true, sandbox: { mode: "workspace-write", workspaceRoot: process.cwd() } })).rejects.toThrow(SandboxUnavailableError)
})
