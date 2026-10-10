import { expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
// @ts-expect-error The packaging helper runs directly as native ESM JavaScript.
import { copyRuntimePackage, runtimePackageRoot } from "../scripts/runtime-copy.mjs"
// @ts-expect-error The native asset gate is also an ESM packaging helper.
import { verifyNativeAssets } from "../../../scripts/runtime-native-assets.mjs"

it("ships native packages exposing only a package subpath and native binary", () => {
  const root = mkdtempSync(join(tmpdir(), "ih-native-package-root-"))
  const pkg = join(root, "node_modules", "@img", "native")
  try {
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@img/native", exports: { "./package": "./package.json", "./sharp.node": "./sharp.node" } }))
    writeFileSync(join(pkg, "sharp.node"), "native-fixture")
    const source = runtimePackageRoot("@img/native", root)
    expect(source).toBe(pkg)
    copyRuntimePackage(source, join(root, "shipped"))
    expect(existsSync(join(root, "shipped", "sharp.node"))).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it("ships declared native assets without workspace fixtures or compiler outputs", () => {
  const root=mkdtempSync(join(tmpdir(),"ih-runtime-assets-")), source=join(root,"source"),target=join(root,"out")
  try {
    mkdirSync(source);writeFileSync(join(source,"package.json"),JSON.stringify({name:"@i-harness/fixture",files:["src","artifacts","protocol.md"]}))
    for(const file of ["src/index.ts","artifacts/helper.exe",".tmp/secret","native/target/helper.exe","src/.tmp/secret"]){mkdirSync(join(source,file,".."),{recursive:true});writeFileSync(join(source,file),"fixture")}
    writeFileSync(join(source,"protocol.md"),"protocol")
    copyRuntimePackage(source,target)
    for(const file of ["package.json","src/index.ts","artifacts/helper.exe","protocol.md"])expect(existsSync(join(target,file))).toBe(true)
    for(const file of [".tmp","native","src/.tmp"])expect(existsSync(join(target,file))).toBe(false)
  }finally{rmSync(root,{recursive:true,force:true})}
})

it("ships one shared runtime module instead of per-package source dependency links", () => {
  const root = mkdtempSync(join(tmpdir(), "ih-runtime-copy-"))
  const shared = join(root, "source-shared")
  const consumer = join(root, "source-consumer")
  const modules = join(root, "bundle", "node_modules")
  try {
    mkdirSync(shared, { recursive: true }); mkdirSync(join(consumer, "node_modules"), { recursive: true }); mkdirSync(modules, { recursive: true })
    writeFileSync(join(shared, "package.json"), JSON.stringify({ name: "shared", main: "index.cjs" }))
    writeFileSync(join(shared, "index.cjs"), "module.exports = { hooks: new WeakMap() }")
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", main: "index.cjs" }))
    writeFileSync(join(consumer, "index.cjs"), "module.exports = require('shared')")
    symlinkSync(shared, join(consumer, "node_modules", "shared"), process.platform === "win32" ? "junction" : "dir")
    copyRuntimePackage(shared, join(modules, "shared"))
    copyRuntimePackage(consumer, join(modules, "consumer"))
    const require = createRequire(join(root, "bundle", "entry.cjs"))
    expect(require("consumer")).toBe(require("shared"))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("finds the actual package manifest when package.json resolves into a nested module-format manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "ih-package-root-"))
  const pkg = join(root, "node_modules", "wrapped")
  try {
    mkdirSync(join(pkg, "dist", "cjs"), { recursive: true })
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "wrapped", version: "1.0.0", exports: { "./package.json": "./dist/cjs/package.json" }, dependencies: { shared: "1" } }))
    writeFileSync(join(pkg, "dist", "cjs", "package.json"), JSON.stringify({ type: "commonjs" }))
    expect(runtimePackageRoot("wrapped", root)).toBe(pkg)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it("refuses a changed or missing PTY adapter even when the helper and protocol still match", () => {
  const root = mkdtempSync(join(tmpdir(), "ih-pty-asset-integrity-"))
  const artifacts = join(root, "artifacts", "win32-x64")
  const hash = (text: string) => createHash("sha256").update(text).digest("hex")
  try {
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, "i-harness-windows-helper.exe"), "helper-fixture")
    const adapter = join(artifacts, "i-harness-msys-pty.exe")
    writeFileSync(adapter, "adapter-fixture")
    writeFileSync(join(root, "protocol.md"), "protocol-fixture")
    const manifest = { manifestVersion: 1, protocolVersion: 1, target: "x86_64-pc-windows-msvc",
      helperFile: "i-harness-windows-helper.exe", helperSha256: hash("helper-fixture"), protocolSha256: hash("protocol-fixture"),
      sources: {}, msysPty: { file: "i-harness-msys-pty.exe", sha256: hash("adapter-fixture"), notices: {} as Record<string, string> } }
    for (const name of ["CYGWIN_LICENSE", "COPYING.LIB", "COPYING", "SOURCES.md"]) {
      const relative = `msys-notices/${name}`, content = `notice-fixture-${name}`
      mkdirSync(join(artifacts, "msys-notices"), { recursive: true })
      writeFileSync(join(artifacts, relative), content)
      manifest.msysPty.notices[relative] = hash(content)
    }
    writeFileSync(join(artifacts, "manifest.json"), JSON.stringify(manifest))
    writeFileSync(join(root, "qualification.json"), JSON.stringify({ helperSha256: manifest.helperSha256,
      protocolSha256: manifest.protocolSha256, msysPtyTemplateSha256: manifest.msysPty.sha256,
      assurance: "experimental", observationScope: "historical-one-host" }))
    expect(verifyNativeAssets(root).helperSha256).toBe(manifest.helperSha256)
    writeFileSync(join(root, "qualification.json"), JSON.stringify({ helperSha256: manifest.helperSha256,
      protocolSha256: manifest.protocolSha256, msysPtyTemplateSha256: hash("different-candidate"),
      assurance: "experimental", observationScope: "historical-one-host" }))
    expect(() => verifyNativeAssets(root)).toThrow(/qualification identity/i)
    writeFileSync(join(root, "qualification.json"), JSON.stringify({ helperSha256: manifest.helperSha256,
      protocolSha256: manifest.protocolSha256, msysPtyTemplateSha256: manifest.msysPty.sha256,
      assurance: "experimental", observationScope: "historical-one-host" }))
    writeFileSync(adapter, "changed-adapter")
    expect(() => verifyNativeAssets(root)).toThrow(/MSYS.*digest/i)
    rmSync(adapter)
    expect(() => verifyNativeAssets(root)).toThrow(/ENOENT/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it("refuses a native runtime with missing or altered required source and license notices", () => {
  const root = mkdtempSync(join(tmpdir(), "ih-pty-notice-integrity-")), artifacts = join(root, "artifacts", "win32-x64")
  const hash = (text: string) => createHash("sha256").update(text).digest("hex")
  try {
    mkdirSync(join(artifacts, "msys-notices"), { recursive: true })
    writeFileSync(join(artifacts, "i-harness-windows-helper.exe"), "helper-fixture")
    writeFileSync(join(artifacts, "i-harness-msys-pty.exe"), "adapter-fixture")
    writeFileSync(join(root, "protocol.md"), "protocol-fixture")
    const notices: Record<string, string> = {}
    for (const name of ["CYGWIN_LICENSE", "COPYING.LIB", "COPYING", "SOURCES.md"]) {
      const relative = `msys-notices/${name}`, content = `notice-fixture-${name}`
      writeFileSync(join(artifacts, relative), content)
      notices[relative] = hash(content)
    }
    const manifest = { manifestVersion: 1, protocolVersion: 1, target: "x86_64-pc-windows-msvc",
      helperFile: "i-harness-windows-helper.exe", helperSha256: hash("helper-fixture"), protocolSha256: hash("protocol-fixture"),
      sources: {}, msysPty: { file: "i-harness-msys-pty.exe", sha256: hash("adapter-fixture"), notices } }
    writeFileSync(join(artifacts, "manifest.json"), JSON.stringify(manifest))
    writeFileSync(join(root, "qualification.json"), JSON.stringify({ helperSha256: manifest.helperSha256,
      protocolSha256: manifest.protocolSha256, msysPtyTemplateSha256: manifest.msysPty.sha256,
      assurance: "experimental", observationScope: "historical-one-host" }))
    expect(verifyNativeAssets(root).helperSha256).toBe(manifest.helperSha256)
    const notice = join(artifacts, "msys-notices", "CYGWIN_LICENSE")
    rmSync(notice)
    expect(() => verifyNativeAssets(root)).toThrow(/notices|ENOENT/i)
    writeFileSync(notice, "changed-license")
    expect(() => verifyNativeAssets(root)).toThrow(/notice.*digest/i)
    writeFileSync(notice, "notice-fixture-CYGWIN_LICENSE")
    delete manifest.msysPty.notices["msys-notices/SOURCES.md"]
    writeFileSync(join(artifacts, "manifest.json"), JSON.stringify(manifest))
    expect(() => verifyNativeAssets(root)).toThrow(/notice.*identity/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
