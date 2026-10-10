import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, truncateSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readPickedAttachments } from "../src/main/file-attachments.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ih-picked-files-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const outside = join(root, "outside")
  mkdirSync(workspace)
  mkdirSync(outside)
  return { root, workspace, outside }
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHiUAAAAASUVORK5CYII=", "base64")
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")
const imageHeaders = [
  ["png", "image/png", png],
  ["gif", "image/gif", gif],
  ["jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9])],
  ["webp", "image/webp", Buffer.from("524946460c000000574542505650384c00000000", "hex")],
] as const
const videoHeaders = [
  ["mp4", "video/mp4", Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex")],
  ["mov", "video/quicktime", Buffer.from("0000001466747970717420200000020071742020", "hex")],
  ["webm", "video/webm", Buffer.from("1a45dfa3874282847765626d", "hex")],
] as const

describe("native picked file attachments", () => {
  it.each(videoHeaders)("admits workspace and external %s as bounded local references", async (extension, contentType, header) => {
    const { workspace, outside } = fixture()
    const paths = [join(workspace, `inside.${extension}`), join(outside, `outside.${extension}`)]
    paths.forEach(path => writeFileSync(path, header))
    const result = await readPickedAttachments(workspace, paths, false)
    expect(result.paths).toEqual([])
    expect(result.images).toEqual([])
    expect(result.texts).toHaveLength(2)
    result.texts.forEach((entry, index) => {
      expect(entry.contentType).toBe(contentType)
      expect(JSON.parse(entry.text)).toEqual({ kind: "video-reference", path: realpathSync(paths[index]!).replaceAll("\\", "/"), contentType, bytes: header.length })
      expect(entry.bytes).toBe(header.length)
      expect(entry.text.length).toBeLessThan(1024)
      expect(entry.text).not.toContain("base64")
    })
  })
  it("rejects spoofed video extensions, empty video, and files beyond 256 MiB", async () => {
    const { workspace, outside } = fixture()
    for (const root of [workspace, outside]) {
      const path = join(root, "spoof.mp4")
      for (const bytes of [Buffer.from("not a video"), png, Buffer.alloc(0)]) {
        writeFileSync(path, bytes)
        await expect(readPickedAttachments(workspace, [path], true)).rejects.toThrow(/video|container/i)
      }
      writeFileSync(path, videoHeaders[0][2])
      truncateSync(path, 256 * 1024 * 1024 + 1)
      await expect(readPickedAttachments(workspace, [path], true)).rejects.toThrow(/256 MiB/)
    }
  })
  it("requires WebM document type and a supported MP4 major brand", async () => {
    const { workspace, outside } = fixture()
    const webm = join(outside, "spoof.webm"), mp4 = join(outside, "spoof.mp4")
    writeFileSync(webm, Buffer.from("1a45dfa3847765626d", "hex"))
    const avif = Buffer.from(videoHeaders[0][2]); avif.write("avif", 8, "ascii"); writeFileSync(mp4, avif)
    await expect(readPickedAttachments(workspace, [webm], false)).rejects.toThrow(/video|WebM/i)
    await expect(readPickedAttachments(workspace, [mp4], false)).rejects.toThrow(/video|container/i)
  })
  it("returns canonical workspace references and external UTF-8 context in one mixed batch", async () => {
    const { workspace, outside } = fixture()
    mkdirSync(join(workspace, "src"))
    const source = join(workspace, "src", "main.ts")
    const note = join(outside, "notes.md")
    const image = join(outside, "diagram.png")
    writeFileSync(source, "export const value = 1\n")
    writeFileSync(note, "# Notes\n你好 🙂\n")
    writeFileSync(image, png)
    const result = await readPickedAttachments(workspace, [source, note, image], true)
    expect(result.paths).toEqual(["src/main.ts"])
    expect(result.texts).toEqual([{ name: "notes.md", text: "# Notes\n你好 🙂\n" }])
    expect(result.images).toEqual([{ name: "diagram.png", mediaType: "image/png", dataBase64: png.toString("base64") }])
  })

  it.each(imageHeaders)("uses %s magic bytes even when the selected file has another extension", async (_extension, mediaType, bytes) => {
    const { workspace, outside } = fixture()
    const path = join(outside, "photo.dat")
    writeFileSync(path, bytes)
    expect((await readPickedAttachments(workspace, [path], true)).images).toEqual([{ name: "photo.dat", mediaType, dataBase64: bytes.toString("base64") }])
  })

  it("refuses image payloads explicitly when the active model cannot use images", async () => {
    const { workspace } = fixture()
    const path = join(workspace, "photo.png")
    writeFileSync(path, png)
    await expect(readPickedAttachments(workspace, [path], false)).rejects.toThrow(/image.*support|support.*image/i)
  })

  it("treats an inside junction to an outside text file as context, never as a workspace reference", async () => {
    const { workspace, outside } = fixture()
    writeFileSync(join(outside, "selected.txt"), "outside text\n")
    symlinkSync(outside, join(workspace, "linked"), "junction")
    const result = await readPickedAttachments(workspace, [join(workspace, "linked", "selected.txt")], false)
    expect(result.paths).toEqual([])
    expect(result.texts).toEqual([{ name: "selected.txt", text: "outside text\n" }])
  })

  it("can reference a binary workspace file while refusing external binary and malformed UTF-8", async () => {
    const { workspace, outside } = fixture()
    const inside = join(workspace, "asset.bin")
    const external = join(outside, "asset.bin")
    writeFileSync(inside, Buffer.from([0, 0xff, 2]))
    writeFileSync(external, Buffer.from([0, 0xff, 2]))
    expect(await readPickedAttachments(workspace, [inside], false)).toEqual({ paths: ["asset.bin"], images: [], texts: [] })
    await expect(readPickedAttachments(workspace, [inside, external], true)).rejects.toThrow(/binary|UTF-8|unsupported/i)
    writeFileSync(external, Buffer.from([0xff, 0xfe]))
    await expect(readPickedAttachments(workspace, [external], true)).rejects.toThrow(/UTF-8|unsupported/i)
  })

  it("refuses outside PDF content rather than presenting it as extracted text", async () => {
    const { workspace, outside } = fixture()
    const pdf = join(outside, "report.pdf")
    writeFileSync(pdf, "%PDF-1.7\nnot extracted text\n")
    await expect(readPickedAttachments(workspace, [pdf], true)).rejects.toThrow(/unsupported|PDF|binary/i)
  })

  it("refuses a directory, missing file and malformed native path", async () => {
    const { workspace, outside } = fixture()
    await expect(readPickedAttachments(workspace, [outside], true)).rejects.toThrow(/regular file|directory/i)
    await expect(readPickedAttachments(workspace, [join(outside, "missing.txt")], true)).rejects.toThrow()
    await expect(readPickedAttachments(workspace, ["relative.txt"], true)).rejects.toThrow(/absolute|native|path/i)
    await expect(readPickedAttachments(workspace, [join(outside, "bad\0name")], true)).rejects.toThrow(/path/i)
  })

  it("refuses images larger than 5 MiB and more than ten image selections", async () => {
    const { workspace, outside } = fixture()
    const large = join(outside, "large.png")
    const content = Buffer.alloc(5 * 1024 * 1024 + 1)
    png.copy(content)
    writeFileSync(large, content)
    await expect(readPickedAttachments(workspace, [large], true)).rejects.toThrow(/5 MiB|too large/i)
    const paths = Array.from({ length: 11 }, (_, index) => {
      const path = join(outside, `photo-${index}.png`)
      writeFileSync(path, png)
      return path
    })
    await expect(readPickedAttachments(workspace, paths, true)).rejects.toThrow(/10.*image|image.*10/i)
  })

  it("bounds aggregate image bytes while accepting exactly the per-image byte limit", async () => {
    const { workspace, outside } = fixture()
    const content = Buffer.alloc(5 * 1024 * 1024)
    png.copy(content)
    const paths = Array.from({ length: 5 }, (_, index) => {
      const path = join(outside, `photo-${index}.png`)
      writeFileSync(path, content)
      return path
    })
    const accepted = await readPickedAttachments(workspace, [paths[0]!], true)
    expect(Buffer.from(accepted.images[0]!.dataBase64, "base64")).toHaveLength(5 * 1024 * 1024)
    await expect(readPickedAttachments(workspace, paths, true)).rejects.toThrow(/20 MiB|aggregate|total.*image/i)
  })

  it("bounds serialized external context including JSON escaping and combined file count", async () => {
    const { workspace, outside } = fixture()
    const first = join(outside, "one.txt")
    const second = join(outside, "two.txt")
    writeFileSync(first, "x".repeat(35 * 1024))
    writeFileSync(second, "y".repeat(35 * 1024))
    await expect(readPickedAttachments(workspace, [first, second], false)).rejects.toThrow(/64 KiB|context.*limit|too large/i)
    writeFileSync(first, "\n".repeat(40 * 1024))
    await expect(readPickedAttachments(workspace, [first], false)).rejects.toThrow(/64 KiB|context.*limit|too large/i)
    const many = Array.from({ length: 9 }, (_, index) => {
      const path = join(index === 0 ? workspace : outside, `note-${index}.txt`)
      writeFileSync(path, "text\n")
      return path
    })
    await expect(readPickedAttachments(workspace, many, false)).rejects.toThrow(/8.*file|file.*8/i)
  })

  it("deduplicates canonical selections and leaves empty cancellation as an empty batch", async () => {
    const { workspace, outside } = fixture()
    const path = join(outside, "note.txt")
    writeFileSync(path, "note")
    expect(await readPickedAttachments(workspace, [path, join(outside, ".", "note.txt")], false)).toEqual({ paths: [], images: [], texts: [{ name: "note.txt", text: "note" }] })
    expect(await readPickedAttachments(workspace, [], false)).toEqual({ paths: [], images: [], texts: [] })
  })
})
