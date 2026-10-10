import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// Small, intentionally synthetic payload. It exercises native installer file
// operations; the complete real backend is exercised by installer-lifecycle.
export function createInstallerFixture(source, target, variant = "old") {
  const put = (file, text = "fixture") => {
    const path = join(target, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  for (const file of [
    "chrome_100_percent.pak", "chrome_200_percent.pak", "d3dcompiler_47.dll", "dxcompiler.dll",
    "dxil.dll", "ffmpeg.dll", "icudtl.dat", "resources.pak", "v8_context_snapshot.bin", "snapshot_blob.bin",
    "vk_swiftshader.dll", "vulkan-1.dll", "LICENSE", "LICENSES.chromium.html", "locales/en-US.pak",
    "resources/app/out/main/index.js", "resources/app/out/preload/index.cjs", "resources/app/out/renderer/index.html",
    "resources/app/out/main/attachment-reader-worker.mjs", "resources/app/out/main/pdf.worker.mjs",
    "resources/app/out/main/cmaps/fixture.bcmap", "resources/app/out/main/standard_fonts/fixture.pfb",
    "resources/app/out/main/wasm/fixture.wasm", "resources/app/out/main/node_modules/@napi-rs/canvas/package.json",
    "resources/app/licenses/opencode/LICENSE", "resources/app/licenses/zcode/LICENSE", "resources/gateway/cli/src/cli.ts",
    "resources/gateway/cli/src/host.ts", "resources/gateway/node_modules/tsx/dist/loader.mjs",
    variant === "old" ? "resources/gateway/obsolete-owned.txt" : "resources/gateway/current-only.txt",
  ]) put(file)
  for (const file of ["version", "resources/app/package.json", "resources/app/LICENSE", "resources/app/THIRD_PARTY_NOTICES", "resources/gateway/cli/package.json", "resources/gateway/node_modules/tsx/package.json"]) {
    const path = join(target, file); mkdirSync(dirname(path), { recursive: true }); copyFileSync(join(source, file), path)
  }
  const gateway = JSON.parse(readFileSync(join(source, "resources/gateway/cli/package.json"), "utf8"))
  for (const name of Object.keys(gateway.dependencies)) {
    const file = `resources/gateway/node_modules/${name}/package.json`
    const path = join(target, file); mkdirSync(dirname(path), { recursive: true }); copyFileSync(join(source, file), path)
  }
  const manifest = JSON.parse(readFileSync(join(source, "resources/app/package.json"), "utf8"))
  copyFileSync(join(process.env.WINDIR, "System32", "whoami.exe"), join(target, `${manifest.productName}.exe`))
  return target
}
