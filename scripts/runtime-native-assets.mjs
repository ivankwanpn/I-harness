import { createHash } from "node:crypto"
import { cpSync, readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
export function verifyNativeAssets(root, { sources = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, "artifacts/win32-x64/manifest.json"), "utf8"))
  if (manifest.manifestVersion !== 1 || manifest.protocolVersion !== 1 || manifest.target !== "x86_64-pc-windows-msvc"
    || manifest.helperFile !== "i-harness-windows-helper.exe") throw new Error("Invalid native asset manifest identity")
  if (hash(join(root, "artifacts/win32-x64", manifest.helperFile)) !== manifest.helperSha256) throw new Error("Native helper digest mismatch")
  if (hash(join(root, "protocol.md")) !== manifest.protocolSha256) throw new Error("Native protocol digest mismatch")
  const record = JSON.parse(readFileSync(join(root, "qualification.json"), "utf8"))
  if (record.helperSha256 !== manifest.helperSha256 || record.protocolSha256 !== manifest.protocolSha256
    || record.assurance !== "experimental" || record.observationScope !== "historical-one-host") throw new Error("Native qualification identity mismatch")
  if (sources) for (const [file, expected] of Object.entries(manifest.sources)) {
    if (hash(join(root, file)) !== expected) throw new Error(`Stale native helper source: ${file}`)
  }
  return manifest
}

export function copyNativeAssets(source, target) {
  verifyNativeAssets(source, { sources: true })
  mkdirSync(target, { recursive: true })
  for (const file of ["artifacts", "protocol.md", "qualification.json"]) cpSync(join(source, file), join(target, file), { recursive: true })
  verifyNativeAssets(target)
}
