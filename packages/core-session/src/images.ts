export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif"

export interface ImageInput {
  mediaType: ImageMediaType
  dataBase64: string // canonical base64 — NO `data:` prefix, NO whitespace
  // M20: optional durable store ref (`att-<uuid>` from @i-harness/attachment).
  // Purely additive — refs coexist with inline bytes: dataBase64 stays REQUIRED
  // (v0 does NOT migrate bytes out of the log), and store-less sessions keep
  // working. Validation: non-empty string when present (never required).
  attachmentId?: string
  name?: string
  width?: number // host-provided informational metadata (NOT verified in v0)
  height?: number
}

/** Searchable/display metadata of a referenced image, without its base64. */
export interface ImageSummary {
  mediaType: ImageMediaType
  name?: string
  width?: number
  height?: number
  bytes: number
}

// C5 (web-host attachment routes reuse the same capacity rules as a log
// append — one source of truth): exported for the HTTP upload validation.
export const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>(["image/png", "image/jpeg", "image/webp", "image/gif"])
const MAX_IMAGES_PER_MESSAGE = 20
export const MAX_IMAGE_BYTES_PER_MESSAGE = 200 * 1024 * 1024

function isValidBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0 && !s.includes(" ")
}

export function validateImages(images: ImageInput[], evType: string): void {
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`image attachment: at most ${MAX_IMAGES_PER_MESSAGE} images per ${evType}`)
  }
  let bytes = 0
  for (const img of images) {
    if (!IMAGE_MEDIA_TYPES.has(img.mediaType)) {
      throw new Error(`image attachment: unsupported media type ${String(img.mediaType)}`)
    }
    if (!isValidBase64(img.dataBase64)) {
      throw new Error(`image attachment: dataBase64 must be canonical base64 (no data: prefix, no whitespace)`)
    }
    // M20: light check on the optional store ref — never required, but if a
    // caller attaches one it must be usable (an empty id would silently break
    // @i-harness/attachment store lookups).
    if (img.attachmentId !== undefined && (typeof img.attachmentId !== "string" || img.attachmentId.length === 0)) {
      throw new Error(`image attachment: attachmentId must be a non-empty string`)
    }
    bytes += Math.ceil((img.dataBase64.length * 3) / 4)
  }
  if (bytes > MAX_IMAGE_BYTES_PER_MESSAGE) {
    throw new Error(`image attachment: aggregate bytes exceed ${MAX_IMAGE_BYTES_PER_MESSAGE}`)
  }
}

export function imageDescriptor(images: ImageInput[] | undefined): string {
  // Defensive: malformed persisted events may carry a truthy non-array here.
  if (!Array.isArray(images) || images.length === 0) return ""
  return (
    "\n" +
    images.map((i) => `image: ${i.name ?? "unnamed"} ${i.width ?? "?"}x${i.height ?? "?"} ${Math.ceil((i.dataBase64.length * 3) / 4)}B base64:${i.dataBase64.slice(0, 8)}`).join("\n")
  )
}

export function imageSummaryDescriptor(images: ImageSummary[] | undefined): string {
  if (!Array.isArray(images) || images.length === 0) return ""
  return "\n" + images.map((image) => `image: ${image.name ?? "unnamed"} ${image.width ?? "?"}x${image.height ?? "?"} ${image.bytes}B`).join("\n")
}
