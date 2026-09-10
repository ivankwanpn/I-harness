// M40 B8: `read_image` — the model-callable multimodal read. The fs layer owns
// path resolution (workspace-relative + absolute, `..` escape rejected) and the
// read is READ-ONLY: the tool turns an on-disk image file into an ImageInput
// (mime + canonical base64) — the host's provider chain already carries
// `{type:"image", image}` parts (M14). Bytes stay inline on the wire; no store
// write happens here (the attachment store is the host-published upload path).
import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { FsToolError, resolvePath, softFail } from "@i-harness/fs"
import type { FsToolFailure } from "@i-harness/fs"
import type { Tool } from "@i-harness/core-tools"
import type { ImageInput } from "@i-harness/core-session"

export interface ReadImageToolDeps {
  workspace: string
  /** Per-image byte cap (default 10 MiB — the attachment store's default). */
  maxImageBytes?: number
}

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024

const MIME_BY_EXT: Record<string, ImageInput["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export function createReadImageTool(deps: ReadImageToolDeps): Tool<{ path: string }, { images: ImageInput[] } | FsToolFailure> {
  const maxImageBytes = deps.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  return {
    name: "read_image",
    description: "invoke to inspect an image file: path is required (png/jpeg/gif/webp → inline image)",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: true,
    isConcurrencySafe: true,
    // M61: an fs failure is RETURNED, never thrown — a throwing tool body fails
    // the whole turn (core-agent M13/M25) and the call sits in the scrollback
    // with no result at all, which read as "read_image hung".
    execute: async ({ path }) => softFail(async () => {
      const resolved = resolvePath(deps.workspace, path)
      const mediaType = MIME_BY_EXT[extname(resolved).toLowerCase()]
      if (mediaType === undefined) {
        throw new FsToolError("FS_NOT_FOUND", `read_image: unsupported image type for ${path} (only png/jpeg/gif/webp)`)
      }
      const data = await readFile(resolved)
      if (data.byteLength > maxImageBytes) {
        throw new FsToolError("FS_TOO_LARGE", `read_image: image is ${data.byteLength} bytes (max ${maxImageBytes})`)
      }
      return { images: [{ mediaType, dataBase64: data.toString("base64") }] }
    }),
  }
}
