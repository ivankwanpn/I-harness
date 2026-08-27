import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createImageAttachmentStore } from "../src/index.ts"

// 1x1 透明 PNG（canonical base64，無 data: prefix）
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

let workspaceDir: string

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "i-harness-attachment-"))
})

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe("createImageAttachmentStore", () => {
  it("saves an image and returns a durable ref", async () => {
    const store = createImageAttachmentStore({ workspaceDir })
    const input = { data: Uint8Array.from(Buffer.from(PNG_1X1_BASE64, "base64")), mediaType: "image/png" as const, name: "pic.png" }
    const ref = await store.save(input)
    expect(ref.attachmentId).toMatch(/^att-[0-9a-f-]+$/)
    expect(ref.mediaType).toBe("image/png")
    expect(ref.bytes).toBeGreaterThan(0)
    expect(ref.width).toBeUndefined() // store v0 不解析 dimension
  })
  it("loads back the original bytes", async () => {
    const store = createImageAttachmentStore({ workspaceDir })
    const ref = await store.save({ data: Uint8Array.from(Buffer.from(PNG_1X1_BASE64, "base64")), mediaType: "image/png" })
    const img = await store.load(ref)
    expect(img.dataBase64).toBe(PNG_1X1_BASE64)
    expect(img.mediaType).toBe("image/png")
  })
  it("rejects unsupported media type", async () => {
    const store = createImageAttachmentStore({ workspaceDir })
    await expect(store.save({ data: new Uint8Array([1, 2, 3]), mediaType: "image/bmp" as never })).rejects.toThrow(/unsupported media type/)
  })
})
