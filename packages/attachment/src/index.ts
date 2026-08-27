// @i-harness/attachment — image attachment store factory (M20)
//
// Design: absorb dsh's attachment concepts, rewritten as an I-harness create*
// factory. Bytes live under `<workspaceDir>/.i-harness/attachments/<id>.bin`,
// keyed by an opaque id (`att-<uuid>`) that is NEVER a filesystem path.
// Validate-before-publish: `save` validates media type + byte size before any
// write. v0 does NOT parse image dimensions (width/height stay undefined).
import { randomUUID } from "node:crypto"
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises"
import { join, dirname } from "node:path"
import type { ImageInput, ImageMediaType } from "@i-harness/core-session"

export type { ImageMediaType }

export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}

export interface SaveImageAttachment {
  data: Uint8Array
  mediaType: ImageMediaType
  name?: string
}

export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width?: number
  height?: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

export interface ImageAttachmentStore {
  save(input: SaveImageAttachment): Promise<ImageAttachmentRef>
  load(ref: ImageAttachmentRef): Promise<ImageInput>
  resolvePath(ref: ImageAttachmentRef): string
  delete(ref: ImageAttachmentRef): Promise<void>
}

const DEFAULT_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 10 * 1024 * 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 16 * 1024 * 1024,
  maxImageDimension: 8192,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
}

export function createImageAttachmentStore(opts: {
  workspaceDir: string
  limits?: Partial<ImageAttachmentLimits>
}): ImageAttachmentStore {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits }
  const dir = join(opts.workspaceDir, ".i-harness", "attachments")

  async function save(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    if (!limits.mediaTypes.includes(input.mediaType))
      throw new Error(`attachment: unsupported media type ${input.mediaType}`)
    if (input.data.byteLength > limits.maxImageBytes)
      throw new Error(`attachment: image too large (${input.data.byteLength} bytes > ${limits.maxImageBytes})`)
    const id = `att-${randomUUID()}`
    const file = join(dir, `${id}.bin`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, input.data)
    return { attachmentId: id, mediaType: input.mediaType, bytes: input.data.byteLength, name: input.name }
  }
  async function load(ref: ImageAttachmentRef): Promise<ImageInput> {
    const buf = await readFile(resolvePath(ref))
    return { mediaType: ref.mediaType, dataBase64: buf.toString("base64") }
  }
  function resolvePath(ref: ImageAttachmentRef): string {
    return join(dir, `${ref.attachmentId}.bin`)
  }
  async function deleteRef(ref: ImageAttachmentRef): Promise<void> {
    await unlink(resolvePath(ref)).catch(() => {})
  }
  return { save, load, resolvePath, delete: deleteRef }
}
