#!/usr/bin/env node
/**
 * M45 G1: build-dist — the i-harness distribution pipeline.
 *
 *   node scripts/build-dist.mjs [--out dist]
 *
 * 1. esbuild bundle — apps/cli/src/index.ts  →  <out>/ih.mjs
 *    AND packages/sandbox-windows-acl/src/runner.ts → <out>/runner.mjs (the
 *    confinement runner as a sibling bundle — the sandbox seam re-enters it
 *    in dist; platform node, format esm, target node22; the workspace TS
 *    graph is inlined; the three NATIVES are marked external because their
 *    native binaries cannot live inside the bundle: node-pty, koffi,
 *    @vscode/ripgrep. They resolve from <out>/node_modules at runtime.)
 * 2. Copy the already installed, pinned external runtime dependency graph.
 *    No install, download or runtime native compilation occurs. Copy and verify
 *    the package-owned Windows helper/protocol/provenance/qualification assets.
 * 3. layout — <out>/{ih.mjs, runner.mjs + emitted assets, package.json,
 *    node_modules/, README-dist.txt}. The gate is scripts/verify-dist.mjs
 *    (fails loud).
 */

import { build } from "esbuild"
import { copyRuntimePackage, runtimePackageRoot } from "../packages/desktop/scripts/runtime-copy.mjs"
import { copyNativeAssets } from "./runtime-native-assets.mjs"
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve, relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------- constants

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const CLI_ENTRY = join(ROOT, "apps", "cli", "src", "index.ts")
const RUNNER_ENTRY = join(ROOT, "packages", "sandbox-windows-acl", "src", "runner.ts")
const MANIFEST_PATH = join(ROOT, "installer", "dist-package.json")
const NATIVES = ["node-pty", "koffi", "@vscode/ripgrep"]
const EXTERNALS = [...NATIVES]
const STORE_DIR = join(ROOT, "node_modules", ".pnpm")
const TARGET_NODE = "node22"

function fail(msg) {
  console.error(`\n[build-dist] FAIL: ${msg}\n`)
  process.exit(1)
}

function log(...args) {
  console.log("[build-dist]", ...args)
}

function timing(start) {
  return `${(Date.now() - start).toFixed(0)} ms`
}

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2)
let out = "dist"
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i]
  else if (typeof argv[i] === "string" && argv[i].startsWith("--out=")) out = argv[i].slice("--out=".length)
  else fail(`unknown argument: ${argv[i]} (usage: node scripts/build-dist.mjs [--out dist])`)
}
const OUT = resolve(ROOT, out)
const outputRelative = relative(ROOT, OUT)
if (!outputRelative || outputRelative.startsWith("..") || isAbsolute(outputRelative)) fail("output must be a child directory of the workspace")

if (!existsSync(CLI_ENTRY)) fail(`entry not found: ${CLI_ENTRY}`)
if (!existsSync(MANIFEST_PATH)) fail(`deploy manifest not found: ${MANIFEST_PATH} (installer/dist-package.json)`)
if (!existsSync(STORE_DIR)) fail(`pnpm store not found: ${STORE_DIR} — run pnpm install first`)

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
if (!manifest.dependencies) fail("installer/dist-package.json has no dependencies")

// ------------------------------------------- native pins vs. pnpm store check

/** Highest resolved version of `name` present in the .pnpm store (scoped
 * names are encoded node-pty@1.1.0 / @vscode+ripgrep@1.18.0). */
function storeVersion(name) {
  const enc = name.startsWith("@") ? name.replace("/", "+") : name
  const versions = readdirSync(STORE_DIR)
    .filter((d) => d.startsWith(`${enc}@`))
    .map((d) => d.slice(enc.length + 1).split("_")[0])
    .sort((a, b) => {
      const pa = a.split(".").map(Number)
      const pb = b.split(".").map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
      }
      return 0
    })
  return versions.at(-1)
}

for (const name of NATIVES) {
  const pinned = manifest.dependencies[name]
  if (!pinned) fail(`installer/dist-package.json is missing the pinned version of "${name}"`)
  const resolved = storeVersion(name)
  if (!resolved) fail(`"${name}" is not in the pnpm store (${STORE_DIR}) — run pnpm install first`)
  if (resolved !== pinned) {
    fail(
      `native pin drift: installer/dist-package.json has "${name}"@${pinned} but the workspace store resolves ${name}@${resolved} — ` +
        `update the manifest to match (the bundle was compiled against the workspace's natives).`,
    )
  }
  log(`native pin ok: ${name}@${resolved}`)
}

// ---------------------------------------------------------------- fresh out

rmSync(OUT, { recursive: true, force: true })
log(`out dir: ${OUT}`)

// ---------------------------------------------------------------- 1. bundle

/**
 * Bundle one entry point with the shared options. Two entries are emitted:
 *   ih.mjs     — the CLI (the whole backend workspace inlined);
 *   runner.mjs — the windows-acl confinement runner as a SIBLING bundle:
 *                packages/sandbox-windows-acl spawns it in dist
 *                (I_HARNESS_DIST branch of runnerInvocation), so the sandbox
 *                needs no source checkout and no tsx there. The runner has
 *                its own entry guard, so `node runner.mjs` self-executes.
 */
async function bundleEntry(entry, outfile, label) {
  const t = Date.now()
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      target: TARGET_NODE,
      outfile,
      external: EXTERNALS,
      logLevel: "info",
      absWorkingDir: ROOT,
      // DIST marker. Read at runtime by the sandbox's runnerInvocation
      // (packages/sandbox-windows-acl/src/index.ts:470 — the I_HARNESS_DIST
      // branch re-enters the SIBLING runner.mjs instead of the source tsx
      // entry) and by apps/cli's __dist-selfcheck, which fails loud if the dist
      // confinement still goes through tsx. Source runs never set the env, so
      // the branch changes shape ONLY in the bundle.
      // Historical second reason, now gone: apps/tui's direct-entry guard
      // (`import.meta.url === pathToFileURL(argv[1]).href`) would have fired on
      // every `node ih.mjs ...` invocation and booted the TUI alongside main()
      // — that module was deleted in M65 T1, and the marker is still required
      // by the two readers above.
      define: { "process.env.I_HARNESS_DIST": JSON.stringify("1") },
      // esbuild keeps `require("node:stream")`-style calls inside the CJS
      // modules it wraps as a RUNTIME `__require` shim that throws in ESM
      // output ("Dynamic require ... is not supported" — AWS SDK etc. hit
      // this). The shim falls back to a real `require` if one is in scope —
      // supply it: a module-scope createRequire over the bundle URL (the
      // externals + node builtins resolve from <out>/node_modules).
      banner: {
        // alias the import (the bundle's OWN `import { createRequire }`
        // statements — fs-lock etc. — are top-level too; a second binding of
        // the same identifier would be a syntax error).
        js: 'import { createRequire as __bannerCreateRequire } from "node:module";\nconst require = __bannerCreateRequire(import.meta.url);',
      },
    })
    log(`esbuild bundle (${label}): ${outfile} (${timing(t)}) ${result.warnings.length} warnings`)
  } catch (err) {
    fail(`esbuild bundle (${label}) failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

await bundleEntry(CLI_ENTRY, join(OUT, "ih.mjs"), "cli")
await bundleEntry(RUNNER_ENTRY, join(OUT, "runner.mjs"), "acl runner")

// ---------------------------------------------------------------- 2. natives

// Package only installed dependencies; no install or download step.
const copiedNatives = new Set()
function copyInstalled(name, from, optional = false) {
  if (copiedNatives.has(name)) return
  let source
  try { source = runtimePackageRoot(name, from) } catch (error) { if (optional) return; throw error }
  copiedNatives.add(name)
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
  if (manifest.dependencies[name] && manifest.dependencies[name] !== pkg.version) fail(`installed runtime pin drift: ${name}@${pkg.version}, expected ${manifest.dependencies[name]}`)
  copyRuntimePackage(source, join(OUT, "node_modules", ...name.split("/")))
  for (const child of Object.keys(pkg.dependencies ?? {})) copyInstalled(child, source)
  for (const child of Object.keys(pkg.optionalDependencies ?? {})) copyInstalled(child, source, true)
}
for (const name of NATIVES) copyInstalled(name, join(ROOT, name === "@vscode/ripgrep" ? "packages/fs-search" : name === "koffi" ? "packages/sandbox-windows-acl" : "packages/sandbox-local"))
copyInstalled("quickjs-emscripten", join(ROOT, "packages/code-mode"))
copyNativeAssets(join(ROOT, "packages/sandbox-windows-psec"), join(OUT, "sandbox-windows-psec"))

// ------------------------------------------- module-load assets (runtime URLs)

// esbuild leaves `new URL(<static path>, import.meta.url)` UNTOUCHED for node
// targets (node runs the URL natively, so it never rewrites it to a hashed
// asset — the path must be shipped next to the BUNDLE itself). The one
// load-critical asset: @i-harness/provider's model catalog — loadModelCatalog()
// runs at MODULE LOAD, so a missing file fails every command:
{
  const assetFiles = [
    { from: join(ROOT, "packages/provider/src/model-catalog.json"), to: join(OUT, "model-catalog.json") },
    { from: join(ROOT, "packages/fs-search/src/reader.mjs"), to: join(OUT, "reader.mjs") },
    { from: join(ROOT, "packages/code-mode/src/worker.mjs"), to: join(OUT, "worker.mjs") },
    { from: join(ROOT, "packages/code-mode/src/cpu-budget.mjs"), to: join(OUT, "cpu-budget.mjs") },
  ]
  for (const a of assetFiles) {
    if (!existsSync(a.from)) fail(`asset source missing: ${a.from}`)
    copyFileSync(a.from, a.to)
  }
  // drift scan: any OTHER static file-URL the bundle emits that is not
  // resolvable against the out dir is a spawn-time asset — inform loudly.
  // `./runner.ts` is the SOURCE branch of runnerInvocation (tsx); dist takes
  // the `./runner.mjs` sibling-bundle branch, so it is not a missing asset.
  const bundleText = readFileSync(join(OUT, "ih.mjs"), "utf8")
  const staticUrls = [...bundleText.matchAll(/new URL\("((?:\.\.?\/)[^")]+)", import\.meta\.url\)/g)].map((m) => m[1])
  const SOURCE_ONLY_SPAWN_ENTRIES = new Set(["./runner.ts"])
  const unhandled = staticUrls.filter(
    (p) => !p.startsWith("../../../") && !SOURCE_ONLY_SPAWN_ENTRIES.has(p) && !existsSync(join(OUT, p)),
  )
  if (unhandled.length > 0) {
    log(
      `warn: static file-URL(s) in the bundle with no dist artifact: ${unhandled.join(", ")} — ` +
        "spawn-time assets must ship next to the bundle (see README-dist.txt).",
    )
  }
  log(`runtime assets: ${assetFiles.map((a) => a.to).join(", ")} copied`)
}

// ---------------------------------------------------------------- 3. layout files

writeFileSync(
  join(OUT, "package.json"),
  `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      private: true,
      main: "./ih.mjs",
      dependencies: manifest.dependencies,
    },
    null,
    2,
  )}\n`,
)
writeFileSync(
  join(OUT, "README-dist.txt"),
  [
    "i-harness — M45/M55 build-dist bundle",
    "",
    "Layout:",
    "  ih.mjs            the esbuild bundle (the whole CLI/backend workspace inlined)",
    "  runner.mjs        the windows-acl confinement runner (sibling bundle; the",
    "                    sandbox seam spawns it in dist — no source checkout, no tsx)",
    "  node_modules/     installed native externals and the QuickJS worker runtime",
    "  sandbox-windows-psec/  fixed helper, manifest/provenance, protocol, historical qualification",
    "  worker.mjs, cpu-budget.mjs  isolated Code Mode worker assets",
    "  package.json      dist manifest (same dependency pins as installer/dist-package.json)",
    "  model-catalog.json  runtime asset — read as new URL(\"./model-catalog.json\", import.meta.url)",
    "                    by @i-harness/provider at MODULE LOAD; same rule as the bundle, so it",
    "                    must sit next to ih.mjs (esbuild leaves static file-URLs untouched for",
    "                    node targets — it neither rewrites nor copies them).",
    "  reader.mjs        fixed no-spawn search reader; current scoped Exec launches it",
    "                    beside this bundle to relay bounded opened-file bytes.",
    "",
    "Run:",
    "  node ih.mjs --version       # 0.1.0",
    "  node ih.mjs help            # full usage",
    "  node ih.mjs run <task> [--model provider:model --api-key KEY] [--yes]",
    "  node ih.mjs sdk             # SDK stdio server (NDJSON JSON-RPC 2.0)",
    "  node ih.mjs acp             # ACP v1 stdio server",
    "  node ih.mjs sessions list   # list the durable session store",
    "A bare `node ih.mjs` — or any first token that is not a subcommand — prints the",
    "usage on stderr and exits 1: this bundle has NO default UI (M65 T1 removed the",
    "TUI and the web host; the backend is the whole surface).",
    "",
    "The natives are EXTERNAL by design: their platform binaries (node-pty .node,",
    "koffi .node, @vscode/ripgrep rg executable) cannot be embedded in the bundle, so",
    "they resolve from ./node_modules at runtime. No tsx is needed — everything else",
    "is inlined.",
    "",
    "The bundle is SELF-SUFFICIENT (M55) — no source checkout and no tsx:",
    "  - `node ih.mjs sdk` serves the SDK stdio server from this bundle (and `acp`",
    "    serves ACP the same way) — no separate entry point, no tsx;",
    "  - the Windows-ACL sandbox spawns ./runner.mjs next to this bundle.",
    "",
    "Rebuild/verify (from the monorepo):",
    "  node scripts/build-dist.mjs && node scripts/verify-dist.mjs",
    "",
  ].join("\n"),
)

// ---------------------------------------------------------------- info scan

const bundle = readFileSync(join(OUT, "ih.mjs"), "utf8")
const dynImports = [...bundle.matchAll(/import\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1])
const tsDyn = dynImports.filter((p) => p.endsWith(".ts"))
const files = readdirSync(OUT)
log(`info: dynamic imports left in the bundle (esm-unsplittable): ${dynImports.length}`)
for (const p of dynImports) log(`info:   import(${JSON.stringify(p)})`)
if (tsDyn.length > 0) {
  log(`warn: ${tsDyn.length} dynamic .ts import(s) remain — those require a tsx-like loader at runtime;` +
    " the smoke surface does not hit them, but any runtime path that does would fail in dist (no tsx there).")
}
log(`info: out files: ${files.map((f) => `${f} (${statSync(join(OUT, f)).size} bytes)`).join(", ")}`)
log(`done: ${OUT} — run: node scripts/verify-dist.mjs${out === "dist" ? "" : ` --out ${out}`}`)
