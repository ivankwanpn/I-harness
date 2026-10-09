import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

function bytes(path, limit) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error("Unsafe or oversized WSL runtime asset")
  return readFileSync(path)
}
const hash = data => createHash("sha256").update(data).digest("hex")
export function verifyWslAssets(root) {
  const worker = bytes(join(root, "runner.py"), 1024 * 1024)
  const manifest = JSON.parse(bytes(join(root, "manifest.json"), 4096).toString("utf8"))
  if (Object.keys(manifest).sort().join(",") !== "protocol,schema,sha256,worker" || manifest.schema !== 1 || manifest.protocol !== 1 || manifest.worker !== "runner.py") throw new Error("Invalid WSL worker manifest identity")
  if (manifest.sha256 !== hash(worker)) throw new Error("WSL worker digest mismatch")
  return manifest
}
export function copyWslAssets(workerFile, target) {
  const worker = bytes(workerFile, 1024 * 1024)
  mkdirSync(target, { recursive: true })
  for (const file of ["runner.py", "manifest.json"]) {
    try { bytes(join(target, file), 1024 * 1024) } catch (cause) { if (cause.code !== "ENOENT") throw cause }
  }
  writeFileSync(join(target, "runner.py"), worker)
  writeFileSync(join(target, "manifest.json"), JSON.stringify({ schema: 1, protocol: 1, worker: "runner.py", sha256: hash(worker) }) + "\n")
  return verifyWslAssets(target)
}
