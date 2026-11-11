import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { createHash } from "node:crypto"

const root = resolve(import.meta.dirname, "..")
const host = resolve(root, "../..")
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex")
function fresh(label: string) {
  mkdirSync(resolve(host, ".tmp"), { recursive: true })
  return mkdtempSync(resolve(host, ".tmp", `native-input-${label}-`))
}
function snapshot(root: string) {
  return Object.fromEntries(readdirSync(root, { recursive: true }).map(String).sort()
    .filter(name => { try { readFileSync(resolve(root, name)); return true } catch { return false } })
    .map(name => [name.replaceAll("\\", "/"), hash(readFileSync(resolve(root, name)))]))
}
function buildFixture() {
  const fixture = fresh("preflight"), pkg = resolve(fixture, "packages/sandbox-windows-psec")
  const manifest = JSON.parse(readFileSync(resolve(root, "artifacts/win32-x64/manifest.json"), "utf8"))
  for (const path of ["protocol.md", ...Object.keys(manifest.sources)]) {
    const target = resolve(pkg, path); mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(resolve(root, path)).toString("utf8").replaceAll("\r\n", "\n"))
  }
  mkdirSync(resolve(pkg, "scripts"), { recursive: true })
  writeFileSync(resolve(pkg, "scripts/build-native.ps1"), readFileSync(resolve(root, "scripts/build-native.ps1")))
  cpSync(resolve(root, "artifacts"), resolve(pkg, "artifacts"), { recursive: true })
  return { fixture, pkg, output: resolve(fixture, ".tmp/controlled-output"), sdk: resolve(fixture, "absent-sdk") }
}
function invoke(f: ReturnType<typeof buildFixture>, compilerSetup?: string) {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/build-native.ps1", "-BridgeOnly",
    "-ControlledOutputDirectory", f.output, "-MsysSdkDirectory", f.sdk,
    ...(compilerSetup ? ["-CompilerSetup", compilerSetup] : [])]
  const result = spawnSync("powershell.exe", args, { cwd: f.pkg, encoding: "utf8", windowsHide: true, timeout: 15_000 })
  writeFileSync(resolve(f.fixture, "stdout.log"), result.stdout ?? "")
  writeFileSync(resolve(f.fixture, "stderr.log"), result.stderr ?? "")
  writeFileSync(resolve(f.fixture, "invocation.json"), JSON.stringify({ cwd: f.pkg, argv: args, exitCode: result.status, error: result.error?.message }, null, 2))
  return result
}
describe.skipIf(process.platform !== "win32")("native build canonical input boundary", () => {
  it.each(["protocol.md", "native/msys/bridge.c", "native/src/runner/owned-extra.rs"])(
    "rejects CRLF %s before any compiler/output write and preserves every byte", file => {
      const f = buildFixture(), target = resolve(f.pkg, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.endsWith("owned-extra.rs") ? "// uncommitted recursive input\r\n" : readFileSync(target).toString("utf8").replaceAll("\n", "\r\n"))
      const before = snapshot(f.pkg), result = invoke(f)
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`Canonical LF required: ${file}`)
      expect(existsSync(f.output), "preflight must run before controlled output directory creation").toBe(false)
      expect(snapshot(f.pkg)).toEqual(before)
      writeFileSync(resolve(f.fixture, "byte-preservation.json"), JSON.stringify({ before, after: snapshot(f.pkg) }, null, 2))
    }, 20_000)
  it("permits uncommitted canonical LF inputs without requiring Git or HEAD equality", () => {
    const f = buildFixture(), target = resolve(f.pkg, "native/src/runner/owned-extra.rs")
    writeFileSync(target, "// legitimate uncommitted LF input\n")
    // The guard addresses CRLF conversion only; it must not rewrite or reject
    // other exact bytes such as a UTF8 BOM or a lone CR inside owned text.
    writeFileSync(resolve(f.pkg, "native/src/runner/owned-exact.rs"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("// exact lone\rCR bytes\n")]))
    const before = snapshot(f.pkg), result = invoke(f)
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    const vcvars = /^\$vcvars = '([^']+)'/m.exec(readFileSync(resolve(f.pkg, "scripts/build-native.ps1"), "utf8"))?.[1]
    expect(vcvars).toBeDefined()
    expect(result.stderr).toContain(existsSync(vcvars!)
      ? "Pinned MSYS build dependency is absent or changed"
      : "Installed VS2022 BuildTools vcvars64.bat is required")
    expect(result.stderr).not.toContain("Canonical LF required")
    expect(existsSync(f.output)).toBe(true)
    expect(snapshot(f.pkg)).toEqual(before)
  }, 20_000)
  const communitySetup = "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat"
  it.runIf(existsSync(communitySetup))("uses an explicitly selected installed compiler setup without rewriting canonical inputs", () => {
    const f = buildFixture(), before = snapshot(f.pkg), result = invoke(f, communitySetup)
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Pinned MSYS build dependency is absent or changed")
    expect(result.stderr).not.toContain("Installed VS2022 BuildTools vcvars64.bat is required")
    expect(existsSync(f.output)).toBe(true)
    expect(snapshot(f.pkg)).toEqual(before)
  }, 20_000)
  it("preserves exact artifact/upstream notice bytes through Git staging and fresh checkout", () => {
    const fixture = fresh("attributes"), pkg = resolve(fixture, "packages/sandbox-windows-psec")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(resolve(fixture, ".gitattributes"), readFileSync(resolve(host, ".gitattributes")))
    writeFileSync(resolve(pkg, ".gitattributes"), readFileSync(resolve(root, ".gitattributes")))
    const samples = {
      "artifacts/win32-x64/manifest.json": Buffer.from('{\r\n  "fixture": true\n}\r\n'),
      "artifacts/win32-x64/msys-notices/SOURCES.md": Buffer.from("upstream\r\nexact\nbytes\r\n"),
      "native/msys/notices/SOURCES.md": Buffer.from("upstream\r\nexact\nbytes\r\n"),
      "artifacts/win32-x64/helper.exe": Buffer.from([77, 90, 0, 13, 10, 255]),
    }
    for (const [name, bytes] of Object.entries(samples)) {
      const path = resolve(pkg, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
    }
    const git = (args: string[]) => {
      const r = spawnSync("git", ["-c", "core.autocrlf=true", "-C", fixture, ...args], { windowsHide: true,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" } })
      expect(r.status, r.stderr.toString()).toBe(0); return r.stdout
    }
    git(["init", "--template="]); git(["add", "--", ".gitattributes", "packages/sandbox-windows-psec"])
    const checkout = resolve(fixture, "fresh-checkout"); mkdirSync(checkout)
    git(["checkout-index", "--all", `--prefix=${checkout.replaceAll("\\", "/")}/`])
    const observed = Object.entries(samples).map(([name, bytes]) => {
      const relative = `packages/sandbox-windows-psec/${name}`
      return { name, original: hash(bytes), index: hash(git(["show", `:${relative}`])),
        checkout: hash(readFileSync(resolve(checkout, relative))), worktree: hash(readFileSync(resolve(pkg, name))) }
    })
    writeFileSync(resolve(fixture, "exact-bytes.json"), JSON.stringify(observed, null, 2))
    for (const value of observed) {
      expect(value.index, value.name).toBe(value.original)
      expect(value.checkout, value.name).toBe(value.original)
      expect(value.worktree, value.name).toBe(value.original)
    }
  }, 20_000)
})
