import { afterEach, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ownedParent = resolve(packageRoot, "..", "..", ".tmp")
const script = join(packageRoot, "scripts", "build-installer.mjs")
const roots: string[] = []
const owner = "I-harness Desktop installer builder tests v1"

function fixture() {
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
  put("version", "44.4.5")
  put("resources/app/package.json", JSON.stringify({
    name: "@i-harness/desktop", productName: "I-harness Desktop", version: "0.1.0",
    type: "module", main: "./out/main/index.js",
  }))
  put("resources/gateway/cli/package.json", JSON.stringify({
    name: "@i-harness/desktop-gateway", version: "0.1.0", type: "module",
    dependencies: { "@i-harness/sdk": "workspace:*" },
  }))
  put("resources/gateway/node_modules/@i-harness/sdk/package.json", JSON.stringify({ name: "@i-harness/sdk", version: "0.1.0" }))
  put("resources/gateway/node_modules/tsx/package.json", JSON.stringify({ name: "tsx", version: "4.23.12" }))
  return { root, app, put }
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
  expect(JSON.parse(result.stdout)).toMatchObject({ appDir: app, version: "0.1.0", electronVersion: "44.4.5" })
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
