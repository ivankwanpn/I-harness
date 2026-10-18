import { validateImages, type ImageInput } from '@i-harness/core-session'

/** Only supported normalized top-level media positions are presentation data;
 * the complete source object retains every property in its JSON artifact. */
export function resultMedia(value: unknown): readonly ImageInput[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const images = (value as { images?: unknown }).images
  if (!Array.isArray(images) || images.length === 0) {
    const content = (value as { content?: unknown }).content
    if (!Array.isArray(content)) return []
    const normalized = content.flatMap(block => block && typeof block === 'object' && block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
      ? [{ mediaType: block.mimeType, dataBase64: block.data }] : [])
    try { validateImages(normalized, 'MCP result'); return normalized as ImageInput[] } catch { return [] }
  }
  try { validateImages(images, 'result'); return images as ImageInput[] } catch { return [] }
}
