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
 * 2. native deploy — the manifest at installer/dist-package.json pins the
 *    EXACT native versions (with a build-time check against the pnpm store:
 *    drift fails loud). A scratch standalone project (created under the OS
 *    temp dir — NOT inside the repo, or the workspace would capture it) runs
 *    `pnpm install --prod`, and the resulting node_modules is copied to
 *    <out>/node_modules.
 *    NOTE — pnpm 11's `pnpm deploy` is workspace-only by design:
 *    `pnpm --filter=<pkg> deploy <target>` ships the WHOLE dependency tree
 *    of the selected package (the bundle already inlines the workspace TS,
 *    so shipping all of it again would double the payload — this installs
 *    only the pinned externals instead, which is what the dist needs).
 * 3. layout — <out>/{ih.mjs, runner.mjs + emitted assets, package.json,
 *    node_modules/, README-dist.txt}. The gate is scripts/verify-dist.mjs
 *    (fails loud).
 */

import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

// ------------------------------------------------------ pnpm >= 10 guard
//
// The native deploy below installs with `nodeLinker: hoisted` and REQUIRES a
// flat node_modules holding each dependency's optional PLATFORM package
// (@koromix/koffi-win32-x64, @vscode/ripgrep-win32-x64) at the top level —
// koffi/ripgrep resolve them by relative/require.resolve lookups. pnpm 9's
// hoisted linker silently omits those optional packages (the payload then
// boot-fails: "Cannot find the native Koffi module"), and the repo's workspace
// config (allowBuilds / ignoreWorkspaceCycles) is pnpm-10 syntax anyway.
// Fail loud BEFORE bundling so nobody ships a broken payload.
{
  const v = spawnSync("pnpm", ["--version"], { encoding: "utf8", shell: process.platform === "win32" })
  const raw = (v.stdout ?? "").trim()
  const major = Number.parseInt(raw.split(".")[0] ?? "", 10)
  if (!Number.isInteger(major) || major < 10) {
    fail(
      `pnpm >= 10 is required for the native deploy (found ${raw === "" ? "no pnpm on PATH" : `pnpm ${raw}`}) — ` +
        `pnpm 9's hoisted linker omits a dependency's optional platform packages (@koromix/koffi-*, @vscode/ripgrep-*), ` +
        `so the dist would boot-fail on koffi. Upgrade (e.g. \`npm i -g pnpm@10\`) and re-run.`,
    )
  }
  log(`pnpm ${raw} ok (>= 10 required for the native deploy)`)
}

// ---------------------------------------------------------------- fresh out

rmSync(OUT, { recursive: true, force: true })
log(`out dir: ${OUT}`)

// ---------------------------------------------------------------- 1. bundle

/**
 * Bundle one entry point with the shared options. Two entries are emitted:
 *   ih.mjs     — the CLI/TUI (the whole workspace inlined);
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
      // DIST double-entry guard: esbuild merges every module into ONE file
      // with ONE import.meta.url — apps/tui's direct-entry guard
      // (`import.meta.url === pathToFileURL(argv[1]).href`) would fire on
      // every `node ih.mjs ...` invocation and boot the TUI alongside main()
      // (probe escape bytes on stdout). source-run never sets the env — the
      // guard changes shape ONLY in the bundle.
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

{
  const t = Date.now()
  const scratch = mkdtempSync(join(tmpdir(), "ih-dist-deploy-"))
  try {
    // standalone project OUTSIDE the workspace (a commit-compatible piece is
    // installer/dist-package.json; the scratch gets a copy + the build-script
    // approvals, exactly the workspace's pnpm-workspace.yaml pattern).
    // nodeLinker: hoisted — the DEPLOY layout must be FLAT: koffi resolves its
    // native from ../@koromix/koffi-<triplet> and @vscode/ripgrep resolves
    // @vscode/ripgrep-<triplet> via require.resolve — both look at the TOP
    // level of node_modules (pnpm's default isolated layout nests them under
    // .pnpm/<pkg>@<ver>/node_modules, which is invisible to those lookups).
    writeFileSync(join(scratch, "package.json"), JSON.stringify(manifest, null, 2))
    // `packages: ["."]` is REQUIRED: pnpm ≥9 rejects a pnpm-workspace.yaml
    // without a non-empty `packages` field ("packages field missing or empty"),
    // which made every --prod native deploy fail (and, before the installer
    // fix, silently produced a payload with no node_modules at all).
    writeFileSync(
      join(scratch, "pnpm-workspace.yaml"),
      'packages:\n  - "."\nnodeLinker: hoisted\nallowBuilds:\n  node-pty: true\n  koffi: true\n',
    )
    log(`native install: pnpm install --prod in ${scratch}`)
    const r = spawnSync("pnpm", ["install", "--prod"], {
      cwd: scratch,
      shell: process.platform === "win32",
      stdio: "inherit",
      env: process.env,
    })
    if (r.status !== 0) fail(`pnpm install --prod exited ${r.status ?? "with a signal"} (stderr above)`)
    const src = join(scratch, "node_modules")
    if (!existsSync(src)) fail("pnpm install --prod produced no node_modules")
    cpSync(src, join(OUT, "node_modules"), { recursive: true })
    log(`native deploy: node_modules copied (${timing(t)})`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ------------------------------------------- module-load assets (runtime URLs)

// esbuild leaves `new URL(<static path>, import.meta.url)` UNTOUCHED for node
// targets (node runs the URL natively, so it never rewrites it to a hashed
// asset — the path must be shipped next to the BUNDLE itself). The one
// load-critical asset: @i-harness/provider's model catalog — loadModelCatalog()
// runs at MODULE LOAD, so a missing file fails every command:
{
  const assetFiles = [
    { from: join(ROOT, "packages/provider/src/model-catalog.json"), to: join(OUT, "model-catalog.json") },
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
    "  ih.mjs            the esbuild bundle (whole CLI/TUI workspace inlined)",
    "  runner.mjs        the windows-acl confinement runner (sibling bundle; the",
    "                    sandbox seam spawns it in dist — no source checkout, no tsx)",
    "  node_modules/     the NATIVE externals (node-pty, koffi, @vscode/ripgrep)",
    "  package.json      dist manifest (same dependency pins as installer/dist-package.json)",
    "  model-catalog.json  runtime asset — read as new URL(\"./model-catalog.json\", import.meta.url)",
    "                    by @i-harness/provider at MODULE LOAD; same rule as the bundle, so it",
    "                    must sit next to ih.mjs (esbuild leaves static file-URLs untouched for",
    "                    node targets — it neither rewrites nor copies them).",
    "",
    "Run:",
    "  node ih.mjs --version       # 0.1.0",
    "  node ih.mjs help            # full usage",
    "  node ih.mjs tui --help      # tui usage",
    "  node ih.mjs run <task> [--model provider:model --api-key KEY] [--yes]",
    "",
    "The natives are EXTERNAL by design: their platform binaries (node-pty .node,",
    "koffi .node, @vscode/ripgrep rg executable) cannot be embedded in the bundle, so",
    "they resolve from ./node_modules at runtime. No tsx is needed — everything else",
    "is inlined (including the G1 minimal inline engine).",
    "",
    "The bundle is SELF-SUFFICIENT (M55) — no source checkout and no tsx:",
    "  - `tui --attach` spawns the SDK stdio server by re-entering this bundle",
    "    (`node ih.mjs sdk …`);",
    "  - the Windows-ACL sandbox spawns ./runner.mjs next to this bundle;",
    "  - /minimal and /fullscreen relaunch this bundle with the flipped --mode;",
    "  - minimal mode loads the inline engine from the bundle (no fallback).",
    "I_HARNESS_HOME is a DEVELOPMENT-only override for SOURCE runs (a non-standard",
    "checkout for the source SDK spawn); dist ignores it.",
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
    " the smoke surface does not hit them, but a downlevel loader (minimal mode) silently falls back to fullscreen.")
}
log(`info: out files: ${files.map((f) => `${f} (${statSync(join(OUT, f)).size} bytes)`).join(", ")}`)
log(`done: ${OUT} — run: node scripts/verify-dist.mjs${out === "dist" ? "" : ` --out ${out}`}`)
