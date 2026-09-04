// M40 B8: read_image tool — path → ImageInput (mime + canonical base64).
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReadImageTool } from "../src/read-image.ts"

// 1x1 transparent PNG (canonical base64, no data: prefix) — the attachment
// store test's own fixture; round-trip asserts the bytes decode exactly.
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

let workspaceDir: string

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "i-harness-read-image-"))
})

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe("createReadImageTool", () => {
  it("round-trips a real tiny PNG: mime + canonical base64 + exact bytes", async () => {
    const pngPath = join(workspaceDir, "pixel.png")
    writeFileSync(pngPath, Buffer.from(PNG_1X1_BASE64, "base64"))
    const tool = createReadImageTool({ workspace: workspaceDir })
    const { images } = await tool.execute({ path: "pixel.png" }, {})
    expect(images).toHaveLength(1)
    const img = images[0]!
    expect(img.mediaType).toBe("image/png")
    expect(img.dataBase64).toBe(PNG_1X1_BASE64) // canonical, no data: prefix, no whitespace
    expect(Buffer.from(img.dataBase64, "base64")).toEqual(Buffer.from(PNG_1X1_BASE64, "base64"))
  })

  it("resolves mime from the extension family (jpeg/webp/gif)", async () => {
    for (const [name, mime] of [
      ["pixel.jpg", "image/jpeg" as const],
      ["pixel.jpeg", "image/jpeg" as const],
      ["pixel.webp", "image/webp" as const],
      ["pixel.gif", "image/gif" as const],
    ]) {
      writeFileSync(join(workspaceDir, name), Buffer.from([1, 2, 3]))
      const tool = createReadImageTool({ workspace: workspaceDir })
      const { images } = await tool.execute({ path: name }, {})
      expect(images[0]!.mediaType).toBe(mime)
    }
  })

  it("unsupported extension errors fail-loud (no half output)", async () => {
    writeFileSync(join(workspaceDir, "note.txt"), "not an image")
    const tool = createReadImageTool({ workspace: workspaceDir })
    await expect(tool.execute({ path: "note.txt" }, {})).rejects.toThrow(/unsupported image type/)
  })

  it("rejects a path escaping the workspace (fs resolvePath parity)", async () => {
    const tool = createReadImageTool({ workspace: workspaceDir })
    await expect(tool.execute({ path: "../outside.png" }, {})).rejects.toThrow(/escapes workspace/)
  })
})
