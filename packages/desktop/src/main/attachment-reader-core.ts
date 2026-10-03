import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { inflateRawSync } from "node:zlib"
import { SaxesParser } from "saxes"

import { READER_LIMITS } from "./attachment-reader-format.ts"
export interface DocumentSnapshot { text: string; contentType: string; bytes: number; truncated: boolean; reason?: string }
const types: Record<string, string> = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".zip": "application/zip" }
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function utf8(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error("Unsupported binary archive entry; only UTF-8 text entries are readable")
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { throw new Error("Unsupported archive entry encoding; UTF-8 text is required") }
}
/** Validate the complete directory before inflating anything. No archive path is ever opened. */
function archiveEntries(bytes: Buffer): Map<string, Buffer> {
  const fail = (reason: string): never => { throw new Error(`Invalid ZIP archive: ${reason}`) }
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break }
  }
  if (end < 0) fail("missing directory")
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail("multi-disk archives are unsupported")
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryStart = bytes.readUInt32LE(end + 16)
  if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) fail("ZIP64 is unsupported")
  if (count > READER_LIMITS.entries) fail("entry count limit (256) exceeded")
  if (count !== bytes.readUInt16LE(end + 8) || directoryStart + directorySize !== end) fail("inconsistent directory")
  const records: Array<{ name: string; compressed: number; size: number; method: number; crc: number; local: number; start: number; finish: number }> = []
  const seen = new Set<string>(); let at = directoryStart, expanded = 0
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail("broken directory entry")
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), compressed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24)
    const nameLength = bytes.readUInt16LE(at + 28), extraLength = bytes.readUInt16LE(at + 30), commentLength = bytes.readUInt16LE(at + 32), local = bytes.readUInt32LE(at + 42)
    if (at + 46 + nameLength + extraLength + commentLength > end) fail("broken entry lengths")
    if (flags & (1 | 64)) fail("encrypted entries are unsupported")
    if (flags & ~(0x800 | 8 | 2 | 4)) fail("unsupported entry flags")
    if (method !== 0 && method !== 8) fail("unsupported compression method")
    if (bytes.readUInt16LE(at + 34) !== 0 || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) fail("ZIP64 or multi-disk entry is unsupported")
    const name = utf8(bytes.subarray(at + 46, at + 46 + nameLength)).normalize("NFC")
    if (!name || name.length > 4096 || /[\\\0\r\n:]/.test(name) || name.startsWith("/") || name.split("/").some((part, i, all) => part === "." || part === ".." || !part && i < all.length - 1)) fail("unsafe path or traversal")
    const identity = name.replace(/\/$/, "").toLowerCase()
    if (seen.has(identity)) fail("duplicate entry name")
    seen.add(identity)
    if ((bytes.readUInt32LE(at + 38) >>> 16 & 0xf000) === 0xa000) fail("symlink entries are unsupported")
    if (/\.(zip|docx|xlsx|pptx|docm|xlsm|pptm|gz|7z|rar|tar)$/i.test(name)) fail("nested archives are unsupported")
    if (/vbaproject|(?:^|\/)embeddings\//i.test(name)) fail("macros and embedded objects are unsupported")
    if (size > READER_LIMITS.entryBytes || (expanded += size) > READER_LIMITS.expandedBytes || size > Math.max(1024, compressed * READER_LIMITS.expansionRatio)) fail("expanded size or compression ratio limit exceeded")
    if (local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50) fail("missing local entry")
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localName + localExtra, finish = start + compressed
    if (finish > directoryStart || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || !bytes.subarray(local + 30, local + 30 + localName).equals(bytes.subarray(at + 46, at + 46 + nameLength))) fail("inconsistent local entry")
    if (!(flags & 8) && (bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size || bytes.readUInt32LE(local + 14) !== bytes.readUInt32LE(at + 16))) fail("inconsistent entry sizes or checksum")
    if (records.some((record) => local < record.finish && finish > record.local)) fail("overlapping entries")
    records.push({ name, compressed, size, method, crc: bytes.readUInt32LE(at + 16), local, start, finish })
    at += 46 + nameLength + extraLength + commentLength
  }
  if (at !== end) fail("directory length mismatch")
  const entries = new Map<string, Buffer>()
  for (const record of records) {
    const compressed = bytes.subarray(record.start, record.finish)
    let data: Buffer
    try { data = record.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.min(READER_LIMITS.entryBytes, record.size) + 1 }) }
    catch { fail("entry decompression failed or expanded size limit exceeded") }
    if (data!.length !== record.size || crc32(data!) !== record.crc) fail("entry checksum or expanded size mismatch")
    if (data!.subarray(0, 2).toString("ascii") === "PK" || data!.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) || data!.subarray(0, 6).toString("ascii") === "Rar!\x1a\x07") fail("nested archives are unsupported")
    entries.set(record.name, data!)
  }
  return entries
}
class BoundedText {
  text = ""; truncated = false; bytes = 0
  append(value: string) {
    if (this.truncated) return
    const room = READER_LIMITS.textBytes - this.bytes, bytes = Buffer.from(value)
    if (bytes.length <= room) { this.text += value; this.bytes += bytes.length; return }
    let end = room; while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
    this.text += bytes.subarray(0, end).toString("utf8"); this.bytes += end; this.truncated = true
  }
}
function readXml(bytes: Buffer, onOpen: (name: string, attributes: Record<string, string>) => void, onText: (text: string) => void, onClose: (name: string) => void) {
  const parser = new SaxesParser({ xmlns: false })
  parser.on("doctype", () => { throw new Error("XML DTD and entities are unsupported") })
  parser.on("error", (error) => { throw new Error(`Invalid Office XML: ${error.message}`) })
  parser.on("opentag", (tag) => onOpen(tag.name.split(":").at(-1)!, tag.attributes))
  parser.on("text", onText); parser.on("cdata", onText); parser.on("closetag", (tag) => onClose(tag.name.split(":").at(-1)!))
  parser.write(utf8(bytes)).close()
}
function officeText(format: string, entries: Map<string, Buffer>, out: BoundedText) {
  const contentTypes = entries.get("[Content_Types].xml")
  if (!contentTypes) throw new Error("Invalid Office document: content types are missing")
  readXml(contentTypes, (_name, attributes) => { if (Object.values(attributes).some((value) => /macroEnabled|vbaProject/i.test(value))) throw new Error("Macro-enabled Office documents are unsupported") }, () => {}, () => {})
  if (format === ".docx") {
    const document = entries.get("word/document.xml")
    if (!document) throw new Error("Invalid DOCX: document text part is missing")
    let text = false
    readXml(document, (name) => { if (name === "t") text = true; if (name === "tab") out.append("\t"); if (name === "br") out.append("\n") }, (value) => { if (text) out.append(value) }, (name) => { if (name === "t") text = false; if (name === "p") out.append("\n") })
    return
  }
  const parts = [...entries].filter(([name]) => format === ".pptx" ? /^ppt\/slides\/slide\d+\.xml$/.test(name) : /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
  if (!parts.length) throw new Error("Invalid Office document: slide or worksheet text parts are missing")
  const shared: string[] = []
  if (format === ".xlsx" && entries.has("xl/sharedStrings.xml")) {
    let current = "", inText = false
    readXml(entries.get("xl/sharedStrings.xml")!, (name) => { if (name === "si") current = ""; if (name === "t") inText = true }, (value) => { if (inText) current += value }, (name) => { if (name === "t") inText = false; if (name === "si") shared.push(current) })
  }
  for (const [name, bytes] of parts) {
    out.append(`[${name}]\n`)
    let type = "", cell = "", inText = false
    readXml(bytes, (tag, attributes) => { if (tag === "c") { type = attributes.t ?? ""; cell = "" }; if (tag === "t" || tag === "v") inText = true }, (value) => { if (!inText) return; if (format === ".xlsx") cell += value; else out.append(value) }, (tag) => {
      if (tag === "t" || tag === "v") inText = false
      if (format === ".xlsx" && tag === "c") { if (type === "s" && !/^\d+$/.test(cell)) throw new Error("Invalid spreadsheet shared string index"); out.append(type === "s" ? shared[Number(cell)] ?? "[missing shared string]" : cell); out.append("\t") }
      if (tag === "p" || tag === "row") out.append("\n")
    })
  }
}
export async function parseDocument(bytes: Uint8Array, format: string, assetDirectory: string): Promise<DocumentSnapshot> {
  if (!types[format]) throw new Error("Unsupported document format")
  if (bytes.byteLength > READER_LIMITS.inputBytes) throw new Error("Document input limit is 16 MiB")
  const out = new BoundedText(), reasons: string[] = []
  if (format === ".pdf") {
    if (Buffer.from(bytes).includes(Buffer.from("/Encrypt"))) throw new Error("Encrypted PDF attachments are unsupported")
    const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs")
    GlobalWorkerOptions.workerSrc = pathToFileURL(join(assetDirectory, "pdf.worker.mjs")).href
    const task = getDocument({ data: new Uint8Array(bytes), cMapUrl: join(assetDirectory, "cmaps") + "/", cMapPacked: true, standardFontDataUrl: join(assetDirectory, "standard_fonts") + "/", wasmUrl: join(assetDirectory, "wasm") + "/", useWorkerFetch: false, useWasm: false, disableFontFace: true, useSystemFonts: false, enableXfa: false, stopAtErrors: true, verbosity: 0 })
    task.onPassword = () => { void task.destroy() }
    try {
      const pdf = await task.promise
      for (let index = 1; index <= Math.min(pdf.numPages, READER_LIMITS.pdfPages) && !out.truncated; index++) {
        const page = await pdf.getPage(index)
        const stream = page.streamTextContent(), reader = stream.getReader()
        try { while (!out.truncated) { const result = await reader.read(); if (result.done) break; for (const item of result.value.items) if ("str" in item) out.append(item.str + (item.hasEOL ? "\n" : " ")) }; if (out.truncated) await reader.cancel() }
        finally { reader.releaseLock(); page.cleanup() }
        out.append("\n")
      }
      if (pdf.numPages > READER_LIMITS.pdfPages) { out.truncated = true; reasons.push("PDF page limit (100) reached") }
      if (!out.text.trim()) throw new Error("PDF contains no readable text; scanned PDFs require OCR, which is unsupported")
    } catch (error) { throw new Error(`Invalid or unsupported PDF: ${error instanceof Error ? error.message : String(error)}`) }
    finally { await task.destroy() }
  } else {
    const entries = archiveEntries(Buffer.from(bytes))
    if (format !== ".zip") officeText(format, entries, out)
    else {
      let skipped = 0
      for (const [name, data] of entries) {
        if (name.endsWith("/")) continue
        try { const text = utf8(data); out.append(`[${name}]\n${text}\n`) } catch { skipped++ }
      }
      if (skipped) reasons.push(`${skipped} binary or non-UTF-8 entries skipped`)
      if (!out.text.trim()) throw new Error("ZIP contains no supported UTF-8 text entries")
    }
  }
  if (out.truncated) reasons.push("Readable text limit (32 KiB) reached; snapshot truncated")
  return { text: out.text, contentType: types[format]!, bytes: bytes.byteLength, truncated: out.truncated, ...(reasons.length ? { reason: reasons.join("; ") } : {}) }
}
