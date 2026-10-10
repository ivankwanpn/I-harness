import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "esbuild"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { copyWslAssets, verifyWslAssets } from "./runtime-wsl-assets.mjs"

const root = resolve(import.meta.dirname, ".."), worker = join(root, "packages/sandbox-wsl/worker/runner.py")
mkdirSync(join(root, ".tmp"), { recursive: true })
test("copies the exact package worker with its strict protocol/digest manifest", () => {
  const out = mkdtempSync(join(root, ".tmp/wsl-product-integration-assets-"))
  try {
    copyWslAssets(worker, out)
    assert.equal(existsSync(join(out, "runner.py")), true)
    assert.deepEqual(readFileSync(join(out, "runner.py")), readFileSync(worker))
    assert.deepEqual(Object.keys(verifyWslAssets(out)).sort(), ["protocol", "schema", "sha256", "worker"])
    writeFileSync(join(out, "runner.py"), "corrupted")
    assert.throws(() => verifyWslAssets(out), /digest/)
  } finally { rmSync(out, { recursive: true, force: true }) }
})
test("a source-independent CLI bundle captures shipped WSL assets and refuses missing or mismatched assets", async () => {
  const out = mkdtempSync(join(root, ".tmp/wsl-product-integration-wsl-bundle-")), assets = join(out, "wsl-assets")
  try {
    await build({ stdin: { contents: `import {createWslExecutionBackend} from '${join(root, "packages/sandbox-wsl/src/index.ts").replaceAll("\\", "/")}';createWslExecutionBackend({distribution:'Ubuntu'});console.log('packaged-assets-captured')`, resolveDir: root }, bundle: true, platform: "node", format: "esm", outfile: join(out, "probe.mjs"), define: { "process.env.I_HARNESS_DIST": '"1"' } })
    copyWslAssets(worker, assets)
    const run = () => spawnSync(process.execPath, [join(out, "probe.mjs")], { cwd: out, encoding: "utf8" })
    assert.equal(run().status, 0, run().stderr)
    writeFileSync(join(assets, "manifest.json"), JSON.stringify({ schema: 1, protocol: 1, worker: "runner.py", sha256: "bad" }))
    assert.notEqual(run().status, 0); assert.match(run().stderr, /manifest/)
    copyWslAssets(worker, assets)
    rmSync(join(assets, "runner.py"))
    assert.notEqual(run().status, 0); assert.match(run().stderr, /ENOENT/)
  } finally { rmSync(out, { recursive: true, force: true }) }
})
