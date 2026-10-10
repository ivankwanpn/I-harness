import type { ImageInput } from "@i-harness/sdk"
import { open, realpath, stat, type FileHandle } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, win32 } from "node:path"
import { documentFormat, READER_LIMITS, readDocumentSnapshot } from "./attachment-readers.ts"
import type { DocumentSnapshot } from "./attachment-reader-core.ts"
export interface PickedAttachments {
  paths: string[]
  images: Array<ImageInput & { name?: string }>
  texts: Array<{ name: string; text: string } & Partial<Omit<DocumentSnapshot, "text">>>
}
const MAX_IMAGES = 10
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_FILES = 8
const MAX_CONTEXT_BYTES = 64 * 1024
const MAX_VIDEO_BYTES = 256 * 1024 * 1024

/** Identify containers only. read_video's decoder validates the actual streams. */
function videoType(path: string, header: Buffer): string | undefined {
  const extension = extname(path).toLowerCase()
  if (![".mp4", ".m4v", ".mov", ".webm"].includes(extension)) return undefined
  const fail = (): never => { throw new Error("Unsupported or invalid video container; select an MP4, MOV or WebM video") }
  if (extension !== ".webm") {
    if (header.length < 16 || header.toString("ascii", 4, 8) !== "ftyp") return fail()
    const size = header.readUInt32BE(0)
    if (size < 16 || size > header.length || size % 4 !== 0) return fail()
    const brand = header.toString("ascii", 8, 12)
    if (brand === "qt  ") return "video/quicktime"
    if (["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "mp41", "mp42", "avc1", "M4V ", "M4VH", "M4VP", "MSNV", "dash"].includes(brand)) return "video/mp4"
    return fail()
  }
  if (header.length < 5 || header.readUInt32BE(0) !== 0x1a45dfa3) return fail()
  const vint = (at: number, identifier = false): { value: number; width: number } => {
    const first = header[at]
    if (!first) return fail()
    let width = 1, mask = 0x80
    while (!(first & mask)) { width++; mask >>= 1 }
    if (width > 4 || at + width > header.length) return fail()
    let value = identifier ? first : first & (mask - 1)
    for (let i = 1; i < width; i++) value = value * 256 + header[at + i]!
    return { value, width }
  }
  const size = vint(4), end = 4 + size.width + size.value
  if (end > header.length) return fail()
  for (let at = 4 + size.width; at < end;) {
    const id = vint(at, true); at += id.width
    const length = vint(at); at += length.width
    if (at + length.value > end) return fail()
    if (id.value === 0x4282) return header.toString("ascii", at, at + length.value) === "webm" ? "video/webm" : fail()
    at += length.value
  }
  return fail()
}

function mediaType(bytes: Buffer): ImageInput["mediaType"] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif"
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp"
  return undefined
}

function workspaceReference(root: string, file: string): string | undefined {
  const suffix = relative(root, file)
  if (suffix === "" || suffix === ".." || suffix.startsWith("..\\") || suffix.startsWith("../") || isAbsolute(suffix)) return undefined
  const path = suffix.replaceAll("\\", "/")
  if (path.length > 4096 || /[\0\r\n:]/.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("The selected workspace file cannot be represented as a safe relative reference")
  }
  return path
}

async function readUpTo(file: FileHandle, maxBytes: number): Promise<Buffer> {
  const bytes = Buffer.alloc(maxBytes)
  let count = 0
  while (count < maxBytes) {
    const result = await file.read(bytes, count, maxBytes - count, count)
    if (result.bytesRead === 0) break
    count += result.bytesRead
  }
  return bytes.subarray(0, count)
}

/** Paths come only from main's native picker. Choosing an outside text file is
 * an explicit human read; it becomes bounded context rather than an agent path.
 * Nothing is returned until every selected attachment has passed validation. */
export async function readPickedAttachments(workspacePath: string, selectedPaths: string[], allowImages: boolean): Promise<PickedAttachments> {
  if (!Array.isArray(selectedPaths) || selectedPaths.length > MAX_FILES + MAX_IMAGES) throw new Error("Select at most 18 attachment files")
  if (selectedPaths.some((path) => typeof path !== "string" || path === "" || path.includes("\0") || !(isAbsolute(path) || win32.isAbsolute(path)))) {
    throw new Error("Attachment paths must come from an absolute native file selection")
  }
  const result: PickedAttachments = { paths: [], images: [], texts: [] }
  if (selectedPaths.length === 0) return result
  const root = await realpath(workspacePath)
  if (!(await stat(root)).isDirectory()) throw new Error("The attachment workspace must be a directory")
  const seen = new Set<string>()
  let imageBytes = 0

  for (const requested of selectedPaths) {
    const canonical = await realpath(requested)
    const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical
    if (seen.has(identity)) continue
    seen.add(identity)
    const name = Array.from(basename(requested)).slice(0, 256).join("")
    const file = await open(canonical, "r")
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new Error("The selected attachment must be a regular file, not a directory")
      const header = await readUpTo(file, 4096)
      const video = videoType(requested, header)
      if (video) {
        if (info.size === 0 || info.size > MAX_VIDEO_BYTES) throw new Error("Each video must be nonempty and at most 256 MiB")
        if (result.paths.length + result.texts.length >= MAX_FILES) throw new Error("Attach at most 8 non-image files")
        // The picker authorizes this exact external file; absolute reads are
        // supported by read_video. Preserve a reference, never the media bytes.
        const text = JSON.stringify({ kind: "video-reference", path: canonical.replaceAll("\\", "/"), contentType: video, bytes: info.size })
        if (Buffer.byteLength(JSON.stringify([...result.texts.map(({ name, text }) => ({ name, text })), { name, text }])) > MAX_CONTEXT_BYTES) throw new Error("Attachment text context must total at most 64 KiB")
        result.texts.push({ name, text, contentType: video, bytes: info.size, truncated: false })
        continue
      }
      const imageType = mediaType(header)
      if (imageType !== undefined) {
        if (!allowImages) throw new Error("The selected model does not support image attachments")
        if (result.images.length >= MAX_IMAGES) throw new Error("Attach at most 10 images")
        if (info.size > MAX_IMAGE_BYTES) throw new Error("Each image must be at most 5 MiB")
        const bytes = await readUpTo(file, MAX_IMAGE_BYTES + 1)
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Each image must be at most 5 MiB")
        if (mediaType(bytes) !== imageType) throw new Error("The selected image changed while it was being read")
        imageBytes += bytes.length
        if (imageBytes > MAX_IMAGE_TOTAL_BYTES) throw new Error("Image attachments must total at most 20 MiB")
        result.images.push({ name, mediaType: imageType, dataBase64: bytes.toString("base64") })
        continue
      }
      if (result.paths.length + result.texts.length >= MAX_FILES) throw new Error("Attach at most 8 non-image files")
      const format = documentFormat(requested, header)
      if (format) {
        if (info.size > READER_LIMITS.inputBytes) throw new Error("Document input limit is 16 MiB")
        const bytes = await readUpTo(file, READER_LIMITS.inputBytes + 1)
        const snapshot = await readDocumentSnapshot(bytes, format)
        // Keep the prompt-context serialization cap, including JSON escaping.
        const fits = (text: string) => Buffer.byteLength(JSON.stringify([...result.texts.map(({ name, text }) => ({ name, text })), { name, text }])) <= MAX_CONTEXT_BYTES
        if (!fits("")) throw new Error("Attachment text context must total at most 64 KiB")
        if (!fits(snapshot.text)) {
          const points = Array.from(snapshot.text); let low = 0, high = points.length
          while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(points.slice(0, middle).join(""))) low = middle; else high = middle - 1 }
          snapshot.text = points.slice(0, low).join(""); snapshot.truncated = true
          snapshot.reason = [snapshot.reason, "Combined attachment context limit (64 KiB) reached; snapshot truncated"].filter(Boolean).join("; ")
        }
        result.texts.push({ name, ...snapshot }); continue
      }
      const path = workspaceReference(root, canonical)
      if (path !== undefined) { result.paths.push(path); continue }
      const room = MAX_CONTEXT_BYTES - Buffer.byteLength(JSON.stringify(result.texts.map(({ name, text }) => ({ name, text }))), "utf8")
      if (info.size > room) throw new Error("External text context must total at most 64 KiB")
      const bytes = await readUpTo(file, room + 1)
      if (bytes.length > room) throw new Error("External text context must total at most 64 KiB")
      if (bytes.includes(0)) throw new Error("Unsupported external binary attachment; select a UTF-8 text file")
      let text: string
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { throw new Error("Unsupported external attachment encoding; select a UTF-8 text file") }
      result.texts.push({ name, text })
      if (Buffer.byteLength(JSON.stringify(result.texts.map(({ name, text }) => ({ name, text }))), "utf8") > MAX_CONTEXT_BYTES) throw new Error("External text context must total at most 64 KiB")
    } finally { await file.close() }
  }
  return result
}
