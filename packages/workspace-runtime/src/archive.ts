import { gunzipSync } from "node:zlib"
import { NODE_PIN, MAX_ARCHIVE_BYTES, MAX_EXPANDED_BYTES, MAX_ARCHIVE_ENTRIES } from "./pin.ts"

const decode = new TextDecoder("utf-8", { fatal: true })
function text(field: Uint8Array): string {
  const end = field.indexOf(0)
  return decode.decode(end < 0 ? field : field.subarray(0, end))
}
function number(field: Uint8Array): number {
  const value = text(field).trim()
  if (value && !/^[0-7]+$/.test(value)) throw new Error("Invalid archive numeric field")
  const parsed = value ? Number.parseInt(value, 8) : 0
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid archive numeric limit")
  return parsed
}
function admittedPath(input: string): string {
  const path = input.endsWith("/") ? input.slice(0, -1) : input
  if (path.length > 4096 || /[\\\x00-\x1f\x7f<>:"|?*]/.test(path)) throw new Error("Unsafe archive path")
  const parts = path.split("/")
  if (parts[0] !== NODE_PIN.archiveRoot || parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe archive path")
  return parts.slice(1).join("/")
}
const ignoredLinks: Readonly<Record<string, string>> = Object.freeze({
  "bin/npm": "../lib/node_modules/npm/bin/npm-cli.js",
  "bin/npx": "../lib/node_modules/npm/bin/npx-cli.js",
  "bin/corepack": "../lib/node_modules/corepack/dist/corepack.js",
})

/** Parse bounded GNU/ustar records; no archive metadata ever becomes a host link.
 * Only regular Node/npm files are returned. The three exact official launcher
 * symlinks are validated and ignored; npm/npx get local regular LF wrappers.
 */
export function readNodeArchive(bytes: Uint8Array): ReadonlyMap<string, { bytes: Buffer; mode: number }> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Compressed archive limit exceeded")
  let tar: Buffer
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES }) }
  catch (cause) { throw new Error("Invalid gzip archive or expanded archive limit exceeded", { cause }) }
  const selected = new Map<string, { bytes: Buffer; mode: number }>()
  const seen = new Set<string>()
  let longName: string | undefined
  let offset = 0, entries = 0, ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (!header.some(Boolean)) {
      if (longName || offset + 1024 > tar.length || tar.subarray(offset).some(Boolean)) throw new Error("Invalid archive ending")
      ended = true; break
    }
    if (++entries > MAX_ARCHIVE_ENTRIES) throw new Error("Archive entry limit exceeded")
    const expected = number(header.subarray(148, 156))
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (expected !== checksum) throw new Error("Archive header checksum mismatch")
    const size = number(header.subarray(124, 136))
    const end = offset + 512 + size
    if (size > 128 * 1024 * 1024 || end > tar.length) throw new Error("Archive member size limit exceeded")
    const data = tar.subarray(offset + 512, end)
    offset += 512 + Math.ceil(size / 512) * 512
    const type = String.fromCharCode(header[156] || 48)
    if (type === "L") {
      if (longName || size < 2 || size > 4096 || data[size - 1] !== 0 || data.subarray(0, -1).includes(0)) throw new Error("Invalid archive long path")
      longName = decode.decode(data.subarray(0, -1)); continue
    }
    const prefix = text(header.subarray(345, 500))
    const name = longName ?? `${prefix ? prefix + "/" : ""}${text(header.subarray(0, 100))}`
    longName = undefined
    const path = admittedPath(name)
    const key = path.toLowerCase()
    if (seen.has(key)) throw new Error("Duplicate archive path or Windows case alias")
    seen.add(key)
    if (type === "5") { if (size) throw new Error("Invalid archive directory type"); continue }
    if (type === "2" && ignoredLinks[path] === text(header.subarray(157, 257)) && size === 0) continue
    if (type !== "0") throw new Error("Unsafe archive entry type (links and devices are not extracted)")
    if (!path) throw new Error("Invalid archive root file path")
    if (path === "bin/node" || path.startsWith("lib/node_modules/npm/")) {
      selected.set(path, { bytes: data, mode: path === "bin/node" ? 0o555 : 0o444 })
    }
  }
  if (!ended) throw new Error("Truncated archive ending")
  for (const path of ["bin/node", "lib/node_modules/npm/package.json", "lib/node_modules/npm/bin/npm-cli.js", "lib/node_modules/npm/bin/npx-cli.js"]) {
    if (!selected.has(path)) throw new Error(`Incomplete Node/npm archive: ${path}`)
  }
  if (!selected.get("bin/node")!.bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]))) throw new Error("Node archive is not a Linux ELF executable")
  try {
    if (JSON.parse(selected.get("lib/node_modules/npm/package.json")!.bytes.toString("utf8")).version !== NODE_PIN.npmVersion) throw new Error()
  } catch { throw new Error("Node archive npm version mismatch") }
  return selected
}
