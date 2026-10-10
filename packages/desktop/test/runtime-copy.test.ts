import { expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
// @ts-expect-error The packaging helper runs directly as native ESM JavaScript.
import { copyRuntimePackage, runtimePackageRoot } from "../scripts/runtime-copy.mjs"

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
