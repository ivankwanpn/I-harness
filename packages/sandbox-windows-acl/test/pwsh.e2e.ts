import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { describe, expect, it } from "vitest"
import { createWindowsAclSandbox } from "../src/index.ts"

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const launchDeadline = 30_000

function detectPowerShell(): string {
  const searchDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  const candidates = [
    ...searchDirs.map(directory => join(directory, "pwsh.exe")),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ]
  for (const candidate of new Set(candidates)) {
    if (!existsSync(candidate)) continue
    const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8", timeout: 5_000,
    })
    if (!probe.error && probe.status === 0 && /^(?:5|7)\s*$/u.test(probe.stdout.trim())) return candidate
  }
  throw new Error("PowerShell 7 or Windows PowerShell 5 is required for this Windows native gate")
}

describe.skipIf(process.platform !== "win32")("PowerShell provider/runner authority (Windows only)", () => {
  it("reads outside, confines workspace writes, and denies all writes after read-only downgrade", () => {
    const executable = detectPowerShell()
    // The apostrophe deliberately exercises PowerShell single-quoted path escaping.
    const scratch = mkdtempSync(join(tmpdir(), "i-harness-pwsh-'owned-"))
    const workspace = join(scratch, "workspace")
    const outside = join(scratch, "outside.txt")
    const inside = join(workspace, "inside.txt")
    const baseline = Buffer.from("owned outside baseline\r\n", "utf8")
    try {
      mkdirSync(workspace)
      writeFileSync(outside, baseline)
      for (const mode of ["workspace-write", "read-only"] as const) {
        const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode })
        try {
          // PS7 can enter ConstrainedLanguage under read-only confinement;
          // built-in file cmdlets exercise filesystem authority in that mode.
          const script = [
            "$ErrorActionPreference = 'Stop'",
            `Write-Output ('READ: ' + (Get-Content -LiteralPath ${literal(outside)} -Raw -ErrorAction Stop))`,
            `try { Set-Content -LiteralPath ${literal(inside)} -Value ${literal(mode)} -NoNewline -ErrorAction Stop; Write-Output 'INSIDE: OK' } catch { Write-Output 'INSIDE: DENIED' }`,
            `try { Set-Content -LiteralPath ${literal(outside)} -Value 'changed' -NoNewline -ErrorAction Stop; Write-Output 'OUTSIDE: OK' } catch { Write-Output 'OUTSIDE: DENIED' }`,
          ].join("; ")
          const confined = provider.confine(
            [executable, "-NoProfile", "-NonInteractive", "-Command", script],
            { mode, workspaceRoot: workspace, sessionId: "pwsh-owned-fixture" },
          )
          const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), {
            encoding: "utf8", timeout: launchDeadline,
          })
          expect(result.error, `PowerShell: ${executable}; stderr: ${result.stderr}`).toBeUndefined()
          expect(result.status, `Mode: ${mode}; PowerShell: ${executable}; stderr: ${result.stderr}`).toBe(0)
          expect(result.stdout).toContain("READ: owned outside baseline")
          expect(result.stdout).toContain(mode === "workspace-write" ? "INSIDE: OK" : "INSIDE: DENIED")
          expect(result.stdout).toContain("OUTSIDE: DENIED")
          expect(readFileSync(outside)).toEqual(baseline)
          // Same file/root on downgrade: a denied overwrite must preserve the earlier write.
          expect(readFileSync(inside, "utf8")).toBe("workspace-write")
        } finally {
          provider.dispose()
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 75_000)
})
