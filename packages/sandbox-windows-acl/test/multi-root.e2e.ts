import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createWindowsAclSandbox } from "../src/index.ts"

const directories: string[] = []
const providers: ReturnType<typeof createWindowsAclSandbox>[] = []
afterEach(() => {
  for (const provider of providers.splice(0)) provider.dispose()
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ih-windows-project-roots-"))
  directories.push(root)
  const first = join(root, "frontend")
  const second = join(root, "backend")
  mkdirSync(first)
  mkdirSync(second)
  writeFileSync(join(second, "seed.txt"), "backend source", "utf8")
  const provider = createWindowsAclSandbox({ mode: "workspace-write", writableDirs: [first] })
  providers.push(provider)
  return { root, first, second, provider }
}

function run(argv: string[]) {
  return spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 30_000, windowsHide: true })
}

function attempts(targets: Record<string, string>) {
  return [process.execPath, "-e", `const fs=require('node:fs');for(const [name,path] of Object.entries(${JSON.stringify(targets)})){try{fs.writeFileSync(path,'changed');console.log(name+': OK')}catch{console.log(name+': DENIED')}}`]
}

describe.skipIf(process.platform !== "win32")("Windows project root confinement", () => {
  it("allows a real shell to read and write a secondary folder", () => {
    const { first, second, provider } = setup()
    const target = join(second, "shell.txt")
    const argv = provider.confine(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop';[IO.File]::ReadAllText('${join(second, "seed.txt")}');[IO.File]::WriteAllText('${target}','project-write')`], {
      mode: "workspace-write", workspaceRoot: first, workspaceRoots: [first, second], sessionId: "multi-root-shell",
    }).argv
    const result = run(argv)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("backend source")
    expect(readFileSync(target, "utf8").trim()).toBe("project-write")
  }, 20_000)

  it("uses only current roots after revocation despite standing prior grants", () => {
    const { root, first, second, provider } = setup()
    const existing = join(second, "created-in-project.txt")
    const policy = { mode: "workspace-write" as const, workspaceRoot: first, workspaceRoots: [first, second], sessionId: "multi-root-revoke" }
    const initial = run(provider.confine(attempts({ FIRST: join(first, "first.txt"), SECOND: existing, OUTSIDE: join(root, "outside.txt") }), policy).argv)
    expect(initial.status, initial.stderr).toBe(0)
    expect(initial.stdout).toContain("FIRST: OK")
    expect(initial.stdout).toContain("SECOND: OK")
    expect(initial.stdout).toContain("OUTSIDE: DENIED")
    expect(existsSync(join(root, "outside.txt"))).toBe(false)
    const next = run(provider.confine(attempts({ FIRST: join(first, "next.txt"), REVOKED_EXISTING: existing, REVOKED_NEW: join(second, "revoked-new.txt") }), { ...policy, workspaceRoots: [first] }).argv)
    expect(next.status, next.stderr).toBe(0)
    expect(next.stdout).toContain("FIRST: OK")
    expect(next.stdout).toContain("REVOKED_EXISTING: DENIED")
    expect(next.stdout).toContain("REVOKED_NEW: DENIED")
    expect(existsSync(join(second, "revoked-new.txt"))).toBe(false)
    const readOnly = run(provider.confine(attempts({ FIRST: join(first, "readonly.txt"), SECOND: join(second, "readonly.txt") }), { ...policy, mode: "read-only" }).argv)
    expect(readOnly.status, readOnly.stderr).toBe(0)
    expect(readOnly.stdout).toContain("FIRST: DENIED")
    expect(readOnly.stdout).toContain("SECOND: DENIED")
  }, 20_000)

  it("supports a standalone call with several roots and no retained session grants", () => {
    const { first, second, provider } = setup()
    const result = run(provider.confine(attempts({ FIRST: join(first, "standalone.txt"), SECOND: join(second, "standalone.txt") }), { mode: "workspace-write", workspaceRoot: first, workspaceRoots: [second] }).argv)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("FIRST: OK")
    expect(result.stdout).toContain("SECOND: OK")
  }, 20_000)
})
