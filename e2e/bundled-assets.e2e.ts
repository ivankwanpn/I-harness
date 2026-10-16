import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import { makeWorkspace, removeWorkspace, REPO_ROOT } from "./helpers.ts"

async function emittedAsset(source: string, assets: { from: string; name: string }[], worker = false) {
  const root = makeWorkspace("ih-bundled-assets-")
  try {
    const output = join(root, "bundle"), entry = join(root, "entry.ts")
    mkdirSync(output)
    writeFileSync(entry, source)
    await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", target: "node22",
      outfile: join(output, "entry.mjs"), external: ["quickjs-emscripten"],
      define: { "process.env.I_HARNESS_DIST": JSON.stringify("1") } })
    for (const asset of assets) {
      copyFileSync(asset.from, join(output, asset.name))
      expect(existsSync(join(root, asset.name))).toBe(false)
    }
    // Dependencies are supplied independently of the asset location under test.
    // The real worker and its CPU-budget sibling execute from the emitted tree.
    if (worker) symlinkSync(join(REPO_ROOT, "packages/code-mode/node_modules"), join(output, "node_modules"), process.platform === "win32" ? "junction" : "dir")
    const env = { ...process.env }
    delete env.I_HARNESS_DIST
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 15_000, windowsHide: true })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    const loader = pathToFileURL(join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")).href
    const sourceResult = run(["--import", loader, entry])
    const bundledResult = run([join(output, "entry.mjs")])
    return { sourceResult, bundledResult }
  } finally { removeWorkspace(root) }
}

it("loads the actual model catalog in source and from a sibling emitted-bundle asset", async () => {
  const module = join(REPO_ROOT, "packages/provider/src/catalog/load.ts")
  const result = await emittedAsset(`import { MODEL_CATALOG_LOADED } from ${JSON.stringify(module)}; console.log(JSON.stringify(MODEL_CATALOG_LOADED))`, [
    { from: join(REPO_ROOT, "packages/provider/src/model-catalog.json"), name: "model-catalog.json" },
  ])
  expect(Object.keys(result.sourceResult.catalog).length).toBeGreaterThan(0)
  expect(result.bundledResult).toEqual(result.sourceResult)
})

it("runs the real owned Code Mode worker and CPU budget from source and sibling bundle assets", async () => {
  const module = join(REPO_ROOT, "packages/code-mode/src/runtime.ts")
  const result = await emittedAsset(`import { createCodeModeRuntime } from ${JSON.stringify(module)};
    async function main(){
    const runtime=createCodeModeRuntime({tools:()=>[],invoke:async()=>{throw new Error('unexpected host tool')}});
    try {let value=await runtime.exec({code:'text("WORKER_ASSET_OK")',yield_time_ms:0}); const cell=value.cellId;
      let waits=0; while(value.status==='running'){if(++waits>8)throw new Error('worker did not complete'); value=await runtime.wait({cell_id:cell,yield_time_ms:1000}); if(value.cellId!==cell)throw new Error('worker owner changed')}
      console.log(JSON.stringify(value))
    } finally {await runtime.dispose()}}
    main().catch(error=>{console.error(error);process.exitCode=1})`, [
    { from: join(REPO_ROOT, "packages/code-mode/src/worker.mjs"), name: "worker.mjs" },
    { from: join(REPO_ROOT, "packages/code-mode/src/cpu-budget.mjs"), name: "cpu-budget.mjs" },
  ], true)
  expect(result.sourceResult).toMatchObject({ status: "completed", text: "WORKER_ASSET_OK" })
  expect(result.bundledResult, JSON.stringify(result.bundledResult)).toMatchObject({ status: "completed", text: "WORKER_ASSET_OK" })
})
