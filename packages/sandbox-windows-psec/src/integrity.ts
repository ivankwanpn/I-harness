import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { packageAssetRoot as packageRoot } from "./assets.ts"

export interface HelperOptions { helperPath?: string; manifestPath?: string }

export async function verifyHelper(options: HelperOptions = {}): Promise<{ helperPath: string; sha256: string }> {
  if (process.platform !== "win32") throw new Error("Windows helper unavailable on this platform")
  if (process.arch !== "x64") throw new Error("Windows helper unavailable for this architecture")
  const manifestPath = options.manifestPath ?? resolve(packageRoot, "artifacts/win32-x64/manifest.json")
  const helperPath = options.helperPath ?? resolve(dirname(manifestPath), "i-harness-windows-helper.exe")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
  if (manifest.manifestVersion !== 1 || manifest.protocolVersion !== 1
    || manifest.target !== "x86_64-pc-windows-msvc" || typeof manifest.helperSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(manifest.helperSha256)) throw new Error("Invalid Windows helper manifest version or hash")
  if (basename(helperPath).toLowerCase() !== String(manifest.helperFile).toLowerCase()) throw new Error("Windows helperFile mismatch")
  const actual = await realpath(helperPath)
  const manifestDirectory = await realpath(dirname(manifestPath))
  if (dirname(actual).toLowerCase() !== manifestDirectory.toLowerCase()) throw new Error("Windows helper and manifest location mismatch")
  const bytes = await readFile(actual)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (sha256 !== manifest.helperSha256) throw new Error("Windows helper hash mismatch")
  const protocolHash = createHash("sha256").update(await readFile(resolve(packageRoot, "protocol.md"))).digest("hex")
  if (protocolHash !== manifest.protocolSha256) throw new Error("Windows helper protocol hash mismatch")
  return { helperPath: actual, sha256 }
}
