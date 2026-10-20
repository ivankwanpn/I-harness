import { boundedPreview } from './preview.ts'

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}
// Only bounded slices are escaped or joined. The original strings, including
// encoded media bodies, remain exclusively in the immutable owned result.
function field(value: unknown, cap = 1024): string {
  return typeof value === 'string' ? boundedPreview(value, cap) : ''
}
function describe(value: unknown, index: number): string {
  const block = record(value), position = `[${index + 1}]`
  if (!block) return `${position} invalid content block (omitted from preview)`
  switch (block.type) {
    case 'text': return `${position} text: ${field(block.text, 2048)}`
    case 'image':
    case 'audio': return `${position} ${block.type}: ${field(block.mimeType)} (encoded data omitted from preview)`
    case 'resource': {
      const resource = record(block.resource)
      return `${position} resource: ${field(resource?.uri)} (${field(resource?.mimeType)})` +
        (typeof resource?.text === 'string' ? ` text: ${field(resource.text, 2048)}` : ' (body omitted from preview)')
    }
    case 'resource_link': return `${position} resource_link: ${field(block.uri)} name: ${field(block.name)} (${field(block.mimeType)})`
    default: return `${position} unsupported block type: ${field(block.type)} (omitted from preview)`
  }
}

/** Called only after a genuine producer hint and the original once-only
 * lowering. This projection grants neither outcome nor native media validity. */
export function mcpPresentation(value: unknown): { preview: string; requiresArtifact: boolean } | undefined {
  const result = record(value)
  if (!result || !Array.isArray(result.content)) return undefined
  const content = result.content
  const structured = Object.hasOwn(result, 'structuredContent') ? '\nStructured content present in the original result.' : ''
  // Reserve bounded space for an omitted-block count and the structured note.
  const cap = 8192 - 128, parts: string[] = []
  let budget = cap - 2, requiresArtifact = false, index = 0
  for (; index < content.length; index++) {
    if (budget < 64) break
    const block = content[index]
    if (record(block)?.type !== 'text') requiresArtifact = true
    const description = describe(block, index)
    const line = boundedPreview(description, budget)
    parts.push(line)
    budget -= Buffer.byteLength(JSON.stringify(line)) + 2
    if (line.length !== description.length) { index++; break }
  }
  const remaining = content.length - index
  if (remaining) {
    parts.push(`${remaining} remaining blocks omitted from preview.`)
    // Unvisited blocks may be non-text. They must not enter inline model text.
    requiresArtifact = true
  }
  if (!content.length) parts.push('MCP result: no content blocks.')
  return { preview: boundedPreview(parts.join('\n') + structured), requiresArtifact }
}
