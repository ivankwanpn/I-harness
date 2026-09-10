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

/** M61: the tool RETURNS its failure (never throws) — a throwing body fails
 * the whole turn and the call would sit in the scrollback with no result. */
async function failureOf(p: Promise<unknown>): Promise<{ error: string; code: string }> {
  const out = (await p) as { error?: string; code?: string }
  expect(out.error, "expected a returned failure, got " + JSON.stringify(out)).toBeTypeOf("string")
  return out as { error: string; code: string }
}

/** The success arm of the union (the tests below assert on images). */
function imagesOf(out: unknown): Array<{ mediaType: string; dataBase64: string }> {
  const images = (out as { images?: Array<{ mediaType: string; dataBase64: string }> }).images
  expect(images, "expected images, got " + JSON.stringify(out).slice(0, 120)).toBeDefined()
  return images!
}

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
    const images = imagesOf(await tool.execute({ path: "pixel.png" }, {}))
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
      const images = imagesOf(await tool.execute({ path: name }, {}))
      expect(images[0]!.mediaType).toBe(mime)
    }
  })

  it("an unsupported extension is a RETURNED failure (no half output)", async () => {
    writeFileSync(join(workspaceDir, "note.txt"), "not an image")
    const tool = createReadImageTool({ workspace: workspaceDir })
    const fail = await failureOf(tool.execute({ path: "note.txt" }, {}))
    expect(fail.code).toBe("FS_NOT_FOUND")
    expect(fail.error).toMatch(/unsupported image type/)
  })

  it("a MISSING file is a returned failure with an ENOENT code (the reported hang)", async () => {
    const tool = createReadImageTool({ workspace: workspaceDir })
    const fail = await failureOf(tool.execute({ path: "nope.png" }, {}))
    expect(fail.code).toBe("ENOENT")
    expect(fail.error).toMatch(/ENOENT|no such file/i)
  })

  it("a path escaping the workspace is a returned failure (fs resolvePath parity)", async () => {
    const tool = createReadImageTool({ workspace: workspaceDir })
    const fail = await failureOf(tool.execute({ path: "../outside.png" }, {}))
    expect(fail.error).toMatch(/escapes workspace/)
  })

  it("an oversized image is a returned failure (FS_TOO_LARGE)", async () => {
    writeFileSync(join(workspaceDir, "big.png"), Buffer.alloc(64))
    const tool = createReadImageTool({ workspace: workspaceDir, maxImageBytes: 8 })
    const fail = await failureOf(tool.execute({ path: "big.png" }, {}))
    expect(fail.code).toBe("FS_TOO_LARGE")
  })
})
