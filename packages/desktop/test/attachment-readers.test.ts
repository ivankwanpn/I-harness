import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readPickedAttachments } from "../src/main/file-attachments.ts"
import { officeFixture, pdfFixture, zipFixture } from "./attachment-format-fixtures.ts"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(name: string, bytes: Buffer, inside = false) {
  const root = mkdtempSync(join(tmpdir(), "ih-reader-")); roots.push(root)
  const workspace = join(root, "workspace"); mkdirSync(workspace)
  const path = join(inside ? workspace : root, name); writeFileSync(path, bytes)
  return { root, workspace, path }
}
describe("bounded document snapshots", () => {
  it.each(["docx", "xlsx", "pptx"] as const)("reads real %s XML text without executing content", async (kind) => {
    const { workspace, path } = fixture(`selected.${kind}`, officeFixture(kind))
    const result = await readPickedAttachments(workspace, [path], false)
    expect(result.texts[0]).toMatchObject({ text: expect.stringContaining("attachment marker & readable"), contentType: expect.stringContaining("officedocument"), truncated: false })
  })
  it("reads a real PDF selected inside the workspace instead of returning only a binary path", async () => {
    const { workspace, path } = fixture("selected.pdf", pdfFixture(), true)
    const result = await readPickedAttachments(workspace, [path], false)
    expect(result.texts[0]).toMatchObject({ text: expect.stringContaining("attachment marker"), contentType: "application/pdf", truncated: false })
    expect(result.paths).toEqual([])
  })
  it("reads bounded archive text and does not extract a file into the workspace", async () => {
    const { workspace, path } = fixture("selected.zip", zipFixture([{ name: "notes/readme.md", text: "attachment marker" }]))
    expect((await readPickedAttachments(workspace, [path], false)).texts[0]?.text).toContain("attachment marker")
    expect(existsSync(join(workspace, "notes"))).toBe(false)
  })
  it.each([
    ["traversal", [{ name: "../escape.txt", text: "attack" }], /traversal|unsafe|path/i],
    ["duplicate", [{ name: "note.txt", text: "a" }, { name: "NOTE.txt", text: "b" }], /duplicate/i],
    ["encrypted", [{ name: "note.txt", text: "secret", flags: 0x801 }], /encrypt/i],
    ["bomb", [{ name: "note.txt", text: "a", advertisedSize: 40 * 1024 * 1024 }], /expand|size|limit/i],
    ["nested", [{ name: "inner.zip", text: zipFixture([{ name: "a.txt", text: "a" }]) }], /nested/i],
  ] as const)("rejects %s ZIP explicitly", async (_name, entries, reason) => {
    const { workspace, path } = fixture("selected.zip", zipFixture([...entries]))
    await expect(readPickedAttachments(workspace, [path], false)).rejects.toThrow(reason)
  })
  it("returns truncation metadata at the readable output bound", async () => {
    const { workspace, path } = fixture("selected.docx", officeFixture("docx", "marker ".repeat(10_000)))
    const result = await readPickedAttachments(workspace, [path], false)
    expect(result.texts[0]).toMatchObject({ truncated: true, reason: expect.stringMatching(/limit|truncat/i) })
    expect(Buffer.byteLength(JSON.stringify(result.texts.map(({ name, text }) => ({ name, text }))))).toBeLessThanOrEqual(64 * 1024)
  })
  it("explains malformed PDF and unsupported legacy Office files", async () => {
    const bad = fixture("broken.pdf", Buffer.from("%PDF-1.7 invalid"))
    await expect(readPickedAttachments(bad.workspace, [bad.path], false)).rejects.toThrow(/invalid.*PDF|PDF.*invalid/i)
    const legacy = fixture("old.doc", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
    await expect(readPickedAttachments(legacy.workspace, [legacy.path], false)).rejects.toThrow(/legacy|unsupported.*doc/i)
  })
  it("rejects encrypted PDF dictionaries and explains scanned PDFs without pretending OCR exists", async () => {
    const encrypted = fixture("encrypted.pdf", Buffer.from(pdfFixture().toString().replace("/Size 6", "/Encrypt 6 0 R /Size 7")))
    await expect(readPickedAttachments(encrypted.workspace, [encrypted.path], false)).rejects.toThrow(/encrypted.*PDF/i)
    const scanned = fixture("scanned.pdf", pdfFixture(""))
    await expect(readPickedAttachments(scanned.workspace, [scanned.path], false)).rejects.toThrow(/no readable text|OCR|scanned/i)
  })
  it("rejects XML DTDs and ignores external hyperlinks while reading visible Office text", async () => {
    const bad = fixture("entities.docx", zipFixture([{ name: "[Content_Types].xml", text: "<Types/>" }, { name: "word/document.xml", text: '<!DOCTYPE document SYSTEM "https://invalid.example/entities"><document><t>marker</t></document>' }]))
    await expect(readPickedAttachments(bad.workspace, [bad.path], false)).rejects.toThrow(/DTD|entities/i)
    const good = fixture("linked.docx", zipFixture([{ name: "[Content_Types].xml", text: "<Types/>" }, { name: "word/document.xml", text: '<document><hyperlink target="https://invalid.example/do-not-fetch"><t>attachment marker</t></hyperlink></document>' }]))
    expect((await readPickedAttachments(good.workspace, [good.path], false)).texts[0]?.text).toContain("attachment marker")
  })
  it("bounds declared entry count, real inflation, input size and checksum before accepting a batch", async () => {
    const many = fixture("many.zip", zipFixture(Array.from({ length: 257 }, (_, i) => ({ name: `entry-${i}.txt`, text: "data" }))))
    await expect(readPickedAttachments(many.workspace, [many.path], false)).rejects.toThrow(/entry count|limit/i)
    const dishonest = fixture("dishonest.zip", zipFixture([{ name: "inflate.txt", text: "b".repeat(100_000), advertisedSize: 1 }]))
    await expect(readPickedAttachments(dishonest.workspace, [dishonest.path], false)).rejects.toThrow(/decompression|expand|limit/i)
    const oversized = fixture("oversized.pdf", Buffer.alloc(16 * 1024 * 1024 + 1, 65))
    await expect(readPickedAttachments(oversized.workspace, [oversized.path], false)).rejects.toThrow(/16 MiB|limit/i)
    const corrupt = zipFixture([{ name: "note.txt", text: "data" }]); const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); corrupt.writeUInt32LE(0, 14); corrupt.writeUInt32LE(0, central + 16)
    const invalid = fixture("corrupt.zip", corrupt)
    await expect(readPickedAttachments(invalid.workspace, [invalid.path], false)).rejects.toThrow(/checksum/i)
  })
})
