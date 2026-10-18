import { afterEach, expect, it } from "vitest"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ownedParent = resolve(packageRoot, "..", "..", ".tmp")
const script = join(packageRoot, "scripts", "build-installer.mjs")
const sourceManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
const roots: string[] = []
const owner = "I-harness Desktop installer builder tests v1"

function fixture(version: unknown = sourceManifest.version) {
  mkdirSync(ownedParent, { recursive: true })
  const root = mkdtempSync(join(ownedParent, "desktop-installer-tests-"))
  roots.push(root)
  writeFileSync(join(root, ".test-owner"), owner)
  const app = join(root, "I-harness Desktop")
  const put = (relative: string, data = "fixture") => {
    const target = join(app, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
  for (const file of [
    "I-harness Desktop.exe", "chrome_100_percent.pak", "chrome_200_percent.pak",
    "d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll", "ffmpeg.dll", "icudtl.dat",
    "resources.pak", "v8_context_snapshot.bin", "snapshot_blob.bin", "vk_swiftshader.dll",
    "vulkan-1.dll", "LICENSE", "LICENSES.chromium.html", "locales/en-US.pak",
    "resources/app/out/main/index.js", "resources/app/out/preload/index.cjs",
    "resources/app/out/renderer/index.html", "resources/app/out/main/attachment-reader-worker.mjs",
    "resources/app/out/main/pdf.worker.mjs", "resources/app/out/main/cmaps/fixture.bcmap",
    "resources/app/out/main/standard_fonts/fixture.pfb", "resources/app/out/main/wasm/fixture.wasm",
    "resources/app/out/main/node_modules/@napi-rs/canvas/package.json",
    "resources/app/licenses/opencode/LICENSE", "resources/app/licenses/zcode/LICENSE",
    "resources/app/LICENSE", "resources/app/THIRD_PARTY_NOTICES",
    "resources/gateway/cli/src/cli.ts", "resources/gateway/cli/src/host.ts",
    "resources/gateway/node_modules/tsx/dist/loader.mjs",
  ]) put(file, file.endsWith(".exe") ? "MZfixture executable" : "fixture")
  put("version", sourceManifest.devDependencies.electron)
  put("resources/app/package.json", JSON.stringify({
    name: "@i-harness/desktop", productName: "I-harness Desktop", version,
    type: "module", main: "./out/main/index.js",
  }))
  put("resources/gateway/cli/package.json", JSON.stringify({
    name: "@i-harness/desktop-gateway", version, type: "module",
    dependencies: { "@i-harness/sdk": "workspace:*" },
  }))
  put("resources/gateway/node_modules/@i-harness/sdk/package.json", JSON.stringify({ name: "@i-harness/sdk", version: "0.1.0" }))
  put("resources/gateway/node_modules/tsx/package.json", JSON.stringify({ name: "tsx", version: "4.23.12" }))
  return { root, app, put }
}

// Give each version its own source owner without mutating the working checkout.
function versionFixture(version: unknown) {
  const f = fixture(version)
  const desktop = join(f.root, "packages", "desktop")
  mkdirSync(desktop, { recursive: true })
  cpSync(join(packageRoot, "scripts"), join(desktop, "scripts"), { recursive: true })
  cpSync(join(packageRoot, "installer"), join(desktop, "installer"), { recursive: true })
  mkdirSync(join(desktop, "test"))
  cpSync(join(packageRoot, "test", "installer-fixture-hooks.nsh"), join(desktop, "test", "installer-fixture-hooks.nsh"))
  writeFileSync(join(desktop, "package.json"), JSON.stringify({ ...sourceManifest, version }))
  return { ...f, script: join(desktop, "scripts", "build-installer.mjs") }
}

function validate(app: string, extra: string[] = []) {
  return spawnSync(process.execPath, [script, "--app-dir", app, "--validate-only", ...extra], {
    cwd: packageRoot, encoding: "utf8", windowsHide: true,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== ownedParent || !root.startsWith(join(ownedParent, "desktop-installer-tests-"))) throw new Error("unsafe test cleanup path")
    if (readFileSync(join(root, ".test-owner"), "utf8") !== owner) throw new Error("test cleanup ownership changed")
    rmSync(root, { recursive: true, force: true })
  }
})

it("accepts a complete absolute Desktop payload and reports its app and Electron versions", () => {
  const { app } = fixture()
  const result = validate(app)
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ appDir: app, version: sourceManifest.version, electronVersion: sourceManifest.devDependencies.electron })
})

it.each([
  ["0.1.12", "0.1.12.0"],
  ["0.1.13-rc.1", "0.1.13.0"],
  ["1.2.3-beta.0+build.7", "1.2.3.0"],
  ["65535.65535.65535", "65535.65535.65535.0"],
])("validates the full application version %s separately from Windows numeric version %s", (version, windowsVersion) => {
  const f = versionFixture(version)
  const result = spawnSync(process.execPath, [f.script, "--app-dir", f.app, "--validate-only"], { encoding: "utf8", windowsHide: true })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ version, windowsVersion })
})

it.each(["01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3-01", "1.2.3-rc..1", "1.2.3+", "1.2.3\n", "1.2.3$unsafe", '1.2.3"', "65536.1.2", "1.65536.2", "1.2.65536", "999999999999999999.0.0", 123, null])("rejects malformed, unsafe or unrepresentable version %s before creating output", version => {
  const f = versionFixture(version)
  const output = join(f.root, "rejected-output")
  const result = spawnSync(process.execPath, [f.script, "--app-dir", f.app, "--out-dir", output], { encoding: "utf8", windowsHide: true })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/version/i)
  expect(existsSync(output)).toBe(false)
})

it("refuses a stable gateway under a prerelease Desktop owner", () => {
  const f = fixture()
  f.put("resources/gateway/cli/package.json", JSON.stringify({ name: "@i-harness/desktop-gateway", version: "0.1.13" }))
  const result = validate(f.app)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("gateway")
})

it.each([false, true])("passes full identity and independent PE version to the compiler (isolated fixture: %s)", isolated => {
  const { root, app } = fixture()
  if (isolated) writeFileSync(join(root, ".ih-desktop-installer-test-owner.ini"), "[Test]\nOwner=I-harness.Desktop.Installer.Test.v1\nToken=12345678-1234-1234-1234-123456789012\n")
  const compiler = join(root, "fake-makensis.exe")
  writeFileSync(compiler, "synthetic compiler fixture; never execute")
  const runner = join(root, "compiler-runner.mjs")
  writeFileSync(runner, `
import { buildInstaller } from ${JSON.stringify(pathToFileURL(script).href)}
import { readFileSync, writeFileSync } from "node:fs"
const calls = []
const run = (_file, args) => {
    calls.push(args)
    if (args.includes("/VERSION")) return { status: 0, stdout: "v3.11", stderr: "" }
    const definitions = Object.fromEntries(args.filter(arg => arg.startsWith("/D")).map(arg => {
      const at = arg.indexOf("=")
      return [arg.slice(2, at), arg.slice(at + 1)]
    }))
    writeFileSync(${JSON.stringify(join(root, "definitions.json"))}, JSON.stringify(definitions))
    writeFileSync(definitions.OUTPUT_FILE, "MZsynthetic setup output")
    return { status: 0, stdout: "fixture compiler accepted definitions", stderr: "" }
}
const metadata = buildInstaller(${JSON.stringify({ appDir: app, outDir: join(root, "setup"), nsis: compiler, ...(isolated ? { testRoot: root } : {}) })}, run)
console.log(JSON.stringify({ calls, metadata }))
`)
  const result = spawnSync(process.execPath, [runner], { encoding: "utf8", windowsHide: true })
  expect(result.status, result.stderr).toBe(0)
  const { calls, metadata } = JSON.parse(result.stdout)
  const definitions = JSON.parse(readFileSync(join(root, "definitions.json"), "utf8"))
  expect(definitions.APP_VERSION).toBe("0.1.13-rc.1")
  expect(definitions.WINDOWS_VERSION).toBe("0.1.13.0")
  // Compile-time NSIS contracts; no installer is compiled or executed here.
  const expanded = readFileSync(calls.at(-1).at(-1), "utf8").replace(/\$\{([A-Z_]+)\}/g, (match, key) => definitions[key] ?? match)
  expect(expanded).toContain('VIProductVersion "0.1.13.0"')
  for (const field of ["ProductVersion", "FileVersion"]) expect(expanded).toContain(`VIAddVersionKey "${field}" "0.1.13-rc.1"`)
  expect(expanded).toContain('"Install" "Version" "0.1.13-rc.1"')
  expect(expanded).toContain('"DisplayVersion" "0.1.13-rc.1"')
  expect(expanded).toContain('${If} $0 != "0.1.13-rc.1"')
  if (isolated) {
    expect(definitions.TEST_ROOT).toBe(root)
    expect(definitions.TEST_TOKEN).toBe("12345678-1234-1234-1234-123456789012")
    expect(definitions.TEST_HOOKS).toBe(join(packageRoot, "test", "installer-fixture-hooks.nsh"))
    expect(readFileSync(definitions.TEST_HOOKS, "utf8")).toContain("FailUninstallerBootstrap")
  } else expect(definitions.TEST_ROOT).toBeUndefined()
  expect(calls).toHaveLength(2)
  expect(metadata).toMatchObject({ version: "0.1.13-rc.1", windowsVersion: "0.1.13.0", isolatedTest: isolated })
  expect(JSON.parse(readFileSync(metadata.output.replace(/\.exe$/, ".installer-build.json"), "utf8"))).toMatchObject({ version: "0.1.13-rc.1", windowsVersion: "0.1.13.0" })
})

it("accepts the current I-harness product payload with its matching executable", () => {
  const { app, put } = fixture()
  renameSync(join(app, "I-harness Desktop.exe"), join(app, "I-harness.exe"))
  put("resources/app/package.json", JSON.stringify({ name: "@i-harness/desktop", productName: "I-harness", version: sourceManifest.version, type: "module", main: "./out/main/index.js" }))
  const result = validate(app)
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).appName).toBe("I-harness")
})

it("refuses a current product manifest backed only by the legacy executable", () => {
  const { app, put } = fixture()
  put("resources/app/package.json", JSON.stringify({ name: "@i-harness/desktop", productName: "I-harness", version: sourceManifest.version, type: "module", main: "./out/main/index.js" }))
  const result = validate(app)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("I-harness.exe")
})

it("rejects relative payload paths before resolving them against the build working directory", () => {
  const result = validate("release/I-harness Desktop")
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("absolute")
})

it("rejects an app whose packaged version differs from the Desktop source version", () => {
  const { app, put } = fixture()
  put("resources/app/package.json", JSON.stringify({ name: "@i-harness/desktop", productName: "I-harness Desktop", version: "9.9.9", type: "module", main: "./out/main/index.js" }))
  const result = validate(app)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("version")
})

it("rejects a payload missing an Electron runtime library", () => {
  const { app } = fixture()
  unlinkSync(join(app, "ffmpeg.dll"))
  const result = validate(app)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("ffmpeg.dll")
})

it("rejects a gateway whose declared required dependency was not shipped", () => {
  const { app } = fixture()
  unlinkSync(join(app, "resources/gateway/node_modules/@i-harness/sdk/package.json"))
  const result = validate(app)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("@i-harness/sdk")
})

it("rejects a payload missing the shipped attachment worker", () => {
  const { app } = fixture()
  unlinkSync(join(app, "resources/app/out/main/attachment-reader-worker.mjs"))
  const result = validate(app)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("attachment-reader-worker.mjs")
})

it("rejects linked payload directories rather than silently shipping files from outside the payload", () => {
  const { app, root } = fixture()
  const outside = join(root, "outside")
  mkdirSync(outside)
  writeFileSync(join(outside, "extra.txt"), "outside")
  symlinkSync(outside, join(app, "linked"), process.platform === "win32" ? "junction" : "dir")
  const result = validate(app)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("link")
})

it("rejects a test namespace outside the repository owned temporary directory", () => {
  const { app, root } = fixture()
  const result = validate(app, ["--test-root", dirname(ownedParent)])
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("test root")
  expect(existsSync(join(root, ".test-owner"))).toBe(true)
})

it("rejects output directories inside the payload without creating them", () => {
  const { app } = fixture()
  const output = join(app, "setup-output")
  const result = validate(app, ["--out-dir", output])
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("outside")
  expect(existsSync(output)).toBe(false)
})

it("accepts the payload parent as the installer output directory", () => {
  const { app, root } = fixture()
  const result = validate(app, ["--out-dir", root])
  expect(result.status, result.stderr).toBe(0)
})

it("rejects test ownership markers with an extended owner name", () => {
  const { app, root } = fixture()
  writeFileSync(join(root, ".ih-desktop-installer-test-owner.ini"), "[Test]\nOwner=I-harness.Desktop.Installer.Test.v1.unowned\nToken=12345678-1234-1234-1234-123456789012\n")
  const result = validate(app, ["--test-root", root])
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("ownership")
})

it("accepts an owned test marker with native Windows line endings", () => {
  const { app, root } = fixture()
  writeFileSync(join(root, ".ih-desktop-installer-test-owner.ini"), "[Test]\r\nOwner=I-harness.Desktop.Installer.Test.v1\r\nToken=12345678-1234-1234-1234-123456789012\r\n")
  const result = validate(app, ["--test-root", root])
  expect(result.status, result.stderr).toBe(0)
})

it("rejects a Desktop payload missing its product third party notices", () => {
  const { app } = fixture()
  unlinkSync(join(app, "resources/app/THIRD_PARTY_NOTICES"))
  const result = validate(app)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("THIRD_PARTY_NOTICES")
})
