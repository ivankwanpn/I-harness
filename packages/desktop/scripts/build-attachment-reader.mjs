import { build } from "esbuild"
import { cpSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve, relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { copyRuntimePackage, runtimePackageRoot } from "./runtime-copy.mjs"
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
if (args.length && !(args.length === 2 && args[0] === "--out" && args[1])) throw new Error("Usage: node scripts/build-attachment-reader.mjs [--out DIR]")
const output = resolve(packageRoot, args[1] ?? "out")
const repoRoot = resolve(packageRoot, "../..")
const outputRelative = relative(repoRoot, output)
if (!outputRelative || outputRelative.startsWith("..") || isAbsolute(outputRelative)) throw new Error("attachment output must be a child directory of the workspace")
const out = join(output, "main"), pdf = runtimePackageRoot("pdfjs-dist", packageRoot)
mkdirSync(out, { recursive: true })
await build({ entryPoints: [join(packageRoot, "src/main/attachment-reader-worker.ts")], outfile: join(out, "attachment-reader-worker.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", external: ["@napi-rs/canvas"], banner: { js: 'import { createRequire as __readerCreateRequire } from "node:module"; const require = __readerCreateRequire(import.meta.url);' } })
cpSync(join(pdf, "legacy/build/pdf.worker.mjs"), join(out, "pdf.worker.mjs"))
for (const asset of ["cmaps", "standard_fonts", "wasm"]) cpSync(join(pdf, asset), join(out, asset), { recursive: true })
// PDF.js's supported Node build loads DOM primitives from optional native canvas
// at module initialization, even for text. Ship the installed platform package.
const copied = new Set()
function copy(name, from, required = true) {
  if (copied.has(name)) return
  let source
  try { source = runtimePackageRoot(name, from) } catch (error) { if (required) throw error; return }
  copied.add(name); copyRuntimePackage(source, join(out, "node_modules", ...name.split("/")))
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
  for (const child of Object.keys(manifest.dependencies ?? {})) copy(child, source)
  for (const child of Object.keys(manifest.optionalDependencies ?? {})) copy(child, source, false)
}
copy("@napi-rs/canvas", pdf)
for (const name of ["pdfjs-dist", "saxes", "xmlchars"]) {
  const source = runtimePackageRoot(name, name === "xmlchars" ? runtimePackageRoot("saxes", packageRoot) : packageRoot)
  for (const license of ["LICENSE", "LICENSE.txt", "LICENSE.md"]) { try { cpSync(join(source, license), join(out, `${name.replaceAll("/", "-")}-${license}`)); break } catch {} }
}
console.log(`attachment reader shipped: ${out} (${copied.size} canvas/platform packages, bundled PDF.js + saxes, local CMaps/fonts/wasm)`)
