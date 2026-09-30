import { expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
// @ts-expect-error The packaging helper runs directly as native ESM JavaScript.
import { copyRuntimePackage, runtimePackageRoot } from "../scripts/runtime-copy.mjs"

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
