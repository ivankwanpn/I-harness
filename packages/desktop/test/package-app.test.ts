import { afterEach, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(packageRoot, "../..")
const roots: string[] = []
const label = `release-task7b-source-${process.pid}`
const releaseDir = join(packageRoot, label)
const owner = "Task7b packaging input tests"

function fixture(parent = join(repoRoot, ".tmp")) {
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, "desktop-package-inputs-"))
  roots.push(root)
  writeFileSync(join(root, ".test-owner"), owner)
  return root
}

function run(source: string) {
  return spawnSync(process.execPath, [join(packageRoot, "scripts", "package-app.mjs")], {
    cwd: packageRoot, encoding: "utf8", windowsHide: true,
    env: { ...process.env, IH_DESKTOP_GATEWAY_DIR: source, IH_DESKTOP_RELEASE_LABEL: label },
  })
}

function runtime(root: string, version = "0.1.13-rc.1") {
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  put("cli/package.json", JSON.stringify({ name: "@i-harness/desktop-gateway", version, dependencies: { "@i-harness/sdk": "workspace:*" } }))
  for (const file of ["cli/src/cli.ts", "cli/src/host.ts", "node_modules/tsx/dist/loader.mjs"]) put(file, "runtime fixture")
  for (const name of ["tsx", "@i-harness/sdk"]) put(`node_modules/${name}/package.json`, JSON.stringify({ name }))
  return root
}

function inspect(desktop: string, environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
import { resolvePackagePaths, validateGatewayRuntime } from ${JSON.stringify(pathToFileURL(join(packageRoot, "scripts/package-inputs.mjs")).href)}
const paths = resolvePackagePaths(${JSON.stringify(desktop)}, ${JSON.stringify(environment)})
validateGatewayRuntime(paths.gatewayDir, "0.1.13-rc.1")
console.log(JSON.stringify(paths))
`], { encoding: "utf8", windowsHide: true })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(readFileSync(join(root, ".test-owner"), "utf8")).toBe(owner)
    expect(dirname(root) === join(repoRoot, ".tmp") || dirname(root) === tmpdir() || root === releaseDir).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

it("rejects an explicit missing gateway rather than falling back to the default bundle", () => {
  const source = join(fixture(), "missing-qualified-runtime")
  const result = run(source)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/gateway.*existing/i)
  expect(result.stderr).toContain(source)
})

it("rejects a gateway outside the repository", () => {
  const result = run(fixture(tmpdir()))
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/gateway.*repository/i)
})

it("rejects a linked gateway before inspecting its runtime", () => {
  const root = fixture(), target = join(root, "runtime"), link = join(root, "linked-runtime")
  mkdirSync(target)
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")
  const result = run(link)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/gateway.*canonical|gateway.*link/i)
})

it("rejects gateway input within the selected output before cleanup", () => {
  expect(existsSync(releaseDir)).toBe(false)
  mkdirSync(releaseDir)
  roots.push(releaseDir)
  writeFileSync(join(releaseDir, ".test-owner"), owner)
  const source = join(releaseDir, "qualified-runtime")
  mkdirSync(source)
  writeFileSync(join(source, "qualified-sentinel"), "must survive")
  const result = run(source)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/overlap/i)
  expect(readFileSync(join(source, "qualified-sentinel"), "utf8")).toBe("must survive")
})

it("retains the default gateway and release paths without modifying the runtime", () => {
  const root = fixture(), desktop = join(root, "packages/desktop")
  const gateway = runtime(join(desktop, ".gateway-dist"))
  const before = readFileSync(join(gateway, "cli/package.json"))
  const result = inspect(desktop)
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ gatewayDir: gateway, releaseDir: join(desktop, "release"), appDir: join(desktop, "release/I-harness") })
  expect(readFileSync(join(gateway, "cli/package.json"))).toEqual(before)
})

it("uses a qualified runtime beside the output while preserving default and qualified inputs", () => {
  const root = fixture(), desktop = join(root, "packages/desktop")
  const fallback = runtime(join(desktop, ".gateway-dist"), "0.1.12")
  const source = runtime(join(root, "qualified-runtime"))
  const original = readFileSync(join(source, "cli/package.json"))
  const result = inspect(desktop, { IH_DESKTOP_GATEWAY_DIR: source, IH_DESKTOP_RELEASE_LABEL: "release-rc-qualification" })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ gatewayDir: source, releaseDir: join(desktop, "release-rc-qualification") })
  expect(readFileSync(join(source, "cli/package.json"))).toEqual(original)
  expect(JSON.parse(readFileSync(join(fallback, "cli/package.json"), "utf8")).version).toBe("0.1.12")
  expect(existsSync(join(desktop, "release-rc-qualification"))).toBe(false)
})

it.each(["same", "parent"])("rejects gateway %s of the output before cleanup", relation => {
  const root = fixture(), desktop = join(root, "packages/desktop"), output = join(desktop, "release")
  const source = relation === "same" ? output : desktop
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, "sentinel"), "qualified runtime")
  const result = inspect(desktop, { IH_DESKTOP_GATEWAY_DIR: source })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/overlap/)
  expect(readFileSync(join(source, "sentinel"), "utf8")).toBe("qualified runtime")
})

it("refuses output aliases before cleanup can follow them", () => {
  const root = fixture(), desktop = join(root, "packages/desktop"), source = runtime(join(root, "qualified-runtime"))
  mkdirSync(desktop, { recursive: true })
  symlinkSync(source, join(desktop, "release"), process.platform === "win32" ? "junction" : "dir")
  const result = inspect(desktop, { IH_DESKTOP_GATEWAY_DIR: source })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/output.*canonical/)
  expect(existsSync(join(source, "cli/package.json"))).toBe(true)
})

it("rejects links within an otherwise canonical gateway", () => {
  const root = fixture(), desktop = join(root, "packages/desktop"), source = runtime(join(root, "qualified-runtime"))
  symlinkSync(join(source, "cli/src"), join(source, "linked"), process.platform === "win32" ? "junction" : "dir")
  const result = inspect(desktop, { IH_DESKTOP_GATEWAY_DIR: source })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/runtime.*link/)
})

it.each(["", "relative/runtime", 'D:\\unsafe"runtime', "D:\\unsafe\nruntime"])("rejects unsafe explicit gateway path %s", source => {
  const result = run(source)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/gateway.*absolute/)
})

it.each(["0.1.13", "0.1.12", "0.1.13-rc.2"])("requires full gateway identity equality for %s", version => {
  const root = fixture(), desktop = join(root, "packages/desktop"), source = runtime(join(root, "qualified-runtime"), version)
  const result = inspect(desktop, { IH_DESKTOP_GATEWAY_DIR: source })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/gateway.*version/)
  expect(existsSync(join(desktop, "release"))).toBe(false)
})

it.each(["missing-entry", "missing-dependency", "unsafe-dependency", "wrong-dependency", "wrong-owner"])("refuses unqualified runtime: %s", failure => {
  const root = fixture(), desktop = join(root, "packages/desktop"), source = runtime(join(root, "qualified-runtime"))
  if (failure === "missing-entry") rmSync(join(source, "cli/src/host.ts"))
  if (failure === "missing-dependency") rmSync(join(source, "node_modules/@i-harness/sdk/package.json"))
  if (failure === "wrong-dependency") writeFileSync(join(source, "node_modules/@i-harness/sdk/package.json"), '{"name":"other"}')
  if (failure === "unsafe-dependency") writeFileSync(join(source, "cli/package.json"), JSON.stringify({ name: "@i-harness/desktop-gateway", version: "0.1.13-rc.1", dependencies: { "../escape": "*" } }))
  if (failure === "wrong-owner") writeFileSync(join(source, "cli/package.json"), '{"name":"other","version":"0.1.13-rc.1"}')
  const result = inspect(desktop, { IH_DESKTOP_GATEWAY_DIR: source })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/gateway/)
  expect(existsSync(join(desktop, "release"))).toBe(false)
})

it.each(["../release", "release-..", "release rc", "release\n"])("preserves release-label validation for %s", label => {
  const root = fixture(), desktop = join(root, "packages/desktop"), source = runtime(join(root, "qualified-runtime"))
  const result = inspect(desktop, { IH_DESKTOP_GATEWAY_DIR: source, IH_DESKTOP_RELEASE_LABEL: label })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/release folder label/)
})
