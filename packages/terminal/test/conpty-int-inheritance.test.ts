import { expect, it } from "vitest"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join, resolve, sep, win32 } from "node:path"
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { createExecService, type ExecResult } from "@i-harness/exec"

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.tmp")

type FixtureEvidence = { controllerPid: number; childPid?: number; ready?: boolean; cleanupComplete: boolean; root?: { exitCode: number | null }; settlement?: { kind: string } }
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned fixture PID")
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error }
}
async function launchFixture(mode: "normal" | "missing-int", inspect: (outcome: { result: ExecResult; evidence: FixtureEvidence }) => void, timeout = 19_500) {
  const powershell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
  const fixture = fileURLToPath(new URL("./fixtures/conpty-int.mts", import.meta.url))
  // NULL/TRUE is a process attribute inherited by descendants, independently of
  // ordinary handle inheritance. The dedicated launcher owns this change.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class ConPtyIntLauncher{[DllImport(\"kernel32.dll\",SetLastError=true)]public static extern bool SetConsoleCtrlHandler(IntPtr Handler,bool Add);}'",
    "if (![ConPtyIntLauncher]::SetConsoleCtrlHandler([IntPtr]::Zero,$true)) { throw 'Could not set launcher Ctrl+C inheritance' }",
    `& ${quote(process.execPath)} --import ${quote(pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href)} ${quote(fixture)}`,
    "exit $LASTEXITCODE",
  ].join("\n")
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  mkdirSync(fixtureRoot, { recursive: true })
  const workspace = mkdtempSync(join(fixtureRoot, "sandbox-redesign-conpty-int-"))
  const evidencePath = join(workspace, "evidence.json")
  const launcher = createExecService({ workspaceRoot: workspace })
  try {
    // The foreground native complete-tree Job owns PowerShell, this fixture's
    // controller, and its nested ConPTY child, including an outer timeout.
    const result = await launcher.run({
      argv: [powershell, "-NoLogo", "-NoProfile", "-EncodedCommand", encoded],
      cwd: workspace, env: { ...process.env, TEMP: workspace, TMP: workspace,
        IH_CONPTY_INT_FIXTURE_MODE: mode, IH_CONPTY_INT_FIXTURE_EVIDENCE: evidencePath,
        IH_CONPTY_INT_FIXTURE_DEADLINE: String(Date.now() + 8_000),
      } as Record<string, string>, timeoutMs: timeout,
    })
    inspect({ result, evidence: JSON.parse(readFileSync(evidencePath, "utf8")) as FixtureEvidence })
  } finally {
    // Termination uses retained native Job handles. Recorded PIDs only supply
    // post-settlement observations and never authorize process termination.
    // Failed disposal remains visible and preserves the fixture for diagnosis.
    await launcher.dispose()
    const actual = realpathSync.native(workspace)
    if (!actual.startsWith(realpathSync.native(fixtureRoot) + sep)) throw new Error("Fixture cleanup escaped workspace .tmp")
    rmSync(actual, { recursive: true, force: true })
  }
}

it.skipIf(process.platform !== "win32")("delivers ConPTY INT when its launcher ignores Ctrl+C", async () => {
  await launchFixture("normal", ({ result, evidence }) => {
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`Owned ConPTY Ctrl+C inheritance fixture failed (exit=${result.exitCode}, timedOut=${result.timedOut}):\n${result.stdout}${result.stderr}`)
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      root: { exitCode: 23 },
      settlement: { kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true },
    })
    expect(evidence.cleanupComplete).toBe(true)
    expect(alive(evidence.controllerPid)).toBe(false)
    expect(alive(evidence.childPid!)).toBe(false)
  })
}, 20_000)

it.skipIf(process.platform !== "win32")("settles delayed READY and a missing INT acknowledgement before the outer launcher deadline", async () => {
  await launchFixture("missing-int", ({ result, evidence }) => {
    expect(evidence.ready).toBe(true)
    expect(evidence.cleanupComplete).toBe(true)
    expect(evidence.settlement).toMatchObject({ kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true })
    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBe(false)
    expect(result.stderr).toContain("INT_RECEIVED")
    expect(alive(evidence.controllerPid)).toBe(false)
    expect(alive(evidence.childPid!)).toBe(false)
  }, 10_000)
}, 20_000)

it.skipIf(process.platform !== "win32")("owns the controller and ConPTY child through an outer launcher timeout", async () => {
  await launchFixture("missing-int", ({ result, evidence }) => {
    expect(result.timedOut).toBe(true)
    expect(evidence.cleanupComplete).toBe(false)
    expect(evidence.childPid).toEqual(expect.any(Number))
    expect(alive(evidence.controllerPid)).toBe(false)
    expect(alive(evidence.childPid!)).toBe(false)
  }, 4_000)
}, 20_000)
