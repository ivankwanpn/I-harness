import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, win32 } from "node:path"
import type { ProcessSpec } from "@i-harness/sandbox"
import { auditedGitBashShimSha256s } from "../src/git-bash-shim-manifest.ts"
import { resolveWindowsMsysPty } from "../src/windows-msys-pty.ts"
import { msysPtyPrerequisite } from "./msys-pty-prerequisite.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const auditedBytes = [Buffer.from("audited fixture one"), Buffer.from("audited fixture two")]
const auditedSha256s = auditedBytes.map(sha)
function shim(bytes: Buffer) {
  mkdirSync(resolve(".tmp"), { recursive: true })
  const root = mkdtempSync(resolve(".tmp/msys-prerequisite-")); roots.push(root)
  const path = join(root, "bash.exe")
  writeFileSync(path, bytes)
  return path
}

describe("MSYS PTY audited-shim prerequisite", () => {
  it.each(auditedBytes)("runs for either audited identity read from disk: %s", bytes => {
    expect(msysPtyPrerequisite(shim(bytes), "win32", auditedSha256s)).toEqual({ skip: false, sha256: sha(bytes) })
  })

  it("skips an existing unaudited shim and names the observed hash and audited set", () => {
    const bytes = Buffer.from("unaudited fixture"), observed = sha(bytes)
    const prerequisite = msysPtyPrerequisite(shim(bytes), "win32", auditedSha256s)
    expect(prerequisite.skip).toBe(true)
    expect(prerequisite.sha256).toBe(observed)
    expect(prerequisite.reason).toContain("unaudited Git Bash shim")
    expect(prerequisite.reason).toContain(observed)
    for (const audited of auditedSha256s) expect(prerequisite.reason).toContain(audited)
  })

  it("rechecks actual bytes rather than trusting a file name or a prior hit", () => {
    const path = shim(auditedBytes[0]!)
    expect(msysPtyPrerequisite(path, "win32", auditedSha256s).skip).toBe(false)
    writeFileSync(path, Buffer.from("updated unaudited fixture"))
    expect(msysPtyPrerequisite(path, "win32", auditedSha256s).skip).toBe(true)
  })

  it("explains a missing shim instead of trying to hash it", () => {
    const path = join(shim(auditedBytes[0]!), "missing")
    expect(msysPtyPrerequisite(path, "win32", auditedSha256s)).toMatchObject({ skip: true, reason: expect.stringContaining(path) })
  })

  it("explains unsupported platforms without requiring a Windows file", () => {
    expect(msysPtyPrerequisite("missing/bash.exe", "linux", auditedSha256s)).toMatchObject({ skip: true, reason: expect.stringContaining("win32") })
  })

  const installedShim = win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  it.skipIf(process.platform !== "win32" || !existsSync(installedShim))("bases the installed shim decision on its actual on-disk hash", () => {
    const observed = sha(readFileSync(installedShim)), prerequisite = msysPtyPrerequisite(installedShim)
    expect(prerequisite.skip).toBe(!auditedGitBashShimSha256s.includes(observed))
    expect(prerequisite.sha256).toBe(observed)
    if (prerequisite.skip) {
      const original: ProcessSpec = { argv: [installedShim, "-i"], cwd: process.cwd(), env: {}, owner: { sessionId: "installed-shim-miss" },
        transport: "pty", lifetime: "retain-tree", argumentEncoding: "crt" }
      expect(resolveWindowsMsysPty(original)).toBe(original)
      expect(prerequisite.reason).toContain(observed)
      for (const audited of auditedGitBashShimSha256s) expect(prerequisite.reason).toContain(audited)
    }
  })
})
