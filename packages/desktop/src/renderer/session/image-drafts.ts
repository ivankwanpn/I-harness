import type { ImageInput } from "@i-harness/sdk"
import { publishDraftChange, isDraftRetired } from "./draft-changes.ts"

export interface ImageDraft extends ImageInput { id: number }
const drafts = new Map<string, readonly ImageDraft[]>()
const listeners = new Set<() => void>()
const empty: readonly ImageDraft[] = []
let nextId = 1
const keyFor = (workspace: string, session: string) => JSON.stringify([workspace, session])
const mediaTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
export function readImageDrafts(workspace: string, session: string): readonly ImageDraft[] { return drafts.get(keyFor(workspace, session)) ?? empty }
export function writeImageDrafts(workspace: string, session: string, images: readonly ImageDraft[]): void {
  if (images.length && isDraftRetired(workspace, session)) return
  const key = keyFor(workspace, session)
  if (images.length) drafts.set(key, [...images]); else drafts.delete(key)
  nextId = Math.max(nextId, ...images.map((image) => image.id + 1))
  for (const listener of listeners) listener()
  publishDraftChange(workspace, session)
}
export function subscribeImageDrafts(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Cannot read image"))
    reader.onload = () => {
      const value = reader.result
      if (typeof value !== "string" || !value.includes(",")) reject(new Error("Cannot read image"))
      else resolve(value.slice(value.indexOf(",") + 1))
    }
    reader.readAsDataURL(file)
  })
}

export async function addImageFiles(workspace: string, session: string, files: readonly File[]): Promise<void> {
  if (!files.length) return
  const current = readImageDrafts(workspace, session)
  if (current.length + files.length > 10) throw new Error("最多附加 10 張圖片。")
  if (files.some((file) => !mediaTypes.has(file.type) || file.size === 0 || file.size > 10 * 1024 * 1024)) throw new Error("圖片須為 PNG、JPEG、WebP 或 GIF，且每張不超過 10 MB。")
  const oldBytes = current.reduce((sum, image) => sum + Math.floor(image.dataBase64.length * 3 / 4), 0)
  if (oldBytes + files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) throw new Error("附加圖片合計不能超過 20 MB。")
  const added: ImageDraft[] = []
  for (const file of files) added.push({ id: nextId++, mediaType: file.type as ImageInput["mediaType"], name: file.name.slice(0, 256), dataBase64: await readBase64(file) })
  // Another picker may have completed while FileReader worked: check the live list.
  const latest = readImageDrafts(workspace, session)
  if (latest.length + added.length > 10 || latest.reduce((sum, image) => sum + Math.floor(image.dataBase64.length * 3 / 4), 0) + files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) throw new Error("附加圖片已達上限。")
  writeImageDrafts(workspace, session, [...latest, ...added])
}
