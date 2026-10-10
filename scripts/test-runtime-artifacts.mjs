import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "esbuild"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { copyNativeAssets, verifyNativeAssets } from "./runtime-native-assets.mjs"

const root = resolve(import.meta.dirname, "..")
mkdirSync(join(root, ".tmp"), { recursive: true })
test("bundled native verifier resolves shipped assets and refuses corrupt helper", { skip: process.platform !== "win32" }, async () => {
  const out = mkdtempSync(join(root, ".tmp/sandbox-redesign-artifact-"))
  const pkg = join(root, "packages/sandbox-windows-psec")
  const assets = join(out, "sandbox-windows-psec")
  cpSync(join(pkg, "artifacts"), join(assets, "artifacts"), { recursive: true })
  for (const file of ["protocol.md", "qualification.json"]) cpSync(join(pkg, file), join(assets, file))
  await build({ stdin: { contents: `import { verifyHelper } from '${pkg.replaceAll("\\", "/")}/src/integrity.ts'; console.log(JSON.stringify(await verifyHelper()))`, resolveDir: root },
    bundle: true, platform: "node", format: "esm", outfile: join(out, "probe.mjs"),
    define: { "process.env.I_HARNESS_DIST": '"1"' } })
  const run = () => spawnSync(process.execPath, [join(out, "probe.mjs")], { encoding: "utf8" })
  let result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /421d4a0ed72600d593f5cd1afe8012f49aa0e7ff1ab590486666cf5839e3d395/)
  const helper = join(assets, "artifacts/win32-x64/i-harness-windows-helper.exe")
  const bytes = readFileSync(helper); bytes[0] ^= 1; writeFileSync(helper, bytes)
  result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Windows helper hash mismatch/)
  bytes[0] ^= 1; writeFileSync(helper, bytes)
  rmSync(join(assets,"protocol.md"))
  assert.match(run().stderr,/ENOENT/)
})

test("packaging refuses a missing helper, changed source and mismatched qualification",()=>{
  const fixture=mkdtempSync(join(root,".tmp/sandbox-redesign-asset-build-"))
  const source=join(fixture,"source"),out=join(fixture,"out"),pkg=join(root,"packages/sandbox-windows-psec")
  const manifest=verifyNativeAssets(pkg,{sources:true})
  for(const file of ["artifacts/win32-x64/manifest.json","artifacts/win32-x64/i-harness-windows-helper.exe","protocol.md","qualification.json",...Object.keys(manifest.sources)]) {
    mkdirSync(dirname(join(source,file)),{recursive:true});cpSync(join(pkg,file),join(source,file))
  }
  copyNativeAssets(source,out);assert.equal(verifyNativeAssets(out).helperSha256,manifest.helperSha256)
  const changed=join(source,"native/Cargo.lock");writeFileSync(changed,"stale")
  assert.throws(()=>copyNativeAssets(source,out),/Stale native helper source/)
  cpSync(join(pkg,"native/Cargo.lock"),changed)
  writeFileSync(join(source,"qualification.json"),JSON.stringify({helperSha256:"bad"}))
  assert.throws(()=>copyNativeAssets(source,out),/qualification identity/)
  cpSync(join(pkg,"qualification.json"),join(source,"qualification.json"))
  rmSync(join(source,"artifacts/win32-x64/i-harness-windows-helper.exe"))
  assert.throws(()=>copyNativeAssets(source,out),/ENOENT/)
})
