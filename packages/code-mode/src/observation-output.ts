import type { CodeModeObservation } from './types.ts'

/** Model-facing representation. Media retains its typed contract; the complete
 * escaped ordinary JSON, rather than raw string length, owns the text budget. */
export function observationOutput(out: CodeModeObservation) {
  if (out.policyRefusal) throw Object.assign(new Error(out.error || 'Code Mode policy refusal'), { policyRefusal: true as const })
  const images = out.items.flatMap(item => item.type === 'image' ? [item.image] : [])
  const value = {
    cellId: out.cellId, cell_id: out.cellId, status: out.status, text: out.text, truncated: out.truncated,
    ...(out.yielded ? { yielded: true as const, yield_reason: out.yieldReason } : {}),
    ...(out.textRetention ? { textRetention: { ...out.textRetention } } : {}),
    ...(out.error ? { error: out.error } : {}),
    items: out.items.map(item => item.type === 'text' ? { type: 'text', length: item.text.length }
      : item.type === 'image' ? { type: 'image', mediaType: item.image.mediaType }
        : { type: 'audio', bytes: Math.ceil(item.audioUrl.length * .75) }),
    ...(images.length ? { images } : {}),
  }
  const bytes = () => { const { images: _media, ...ordinary } = value; return Buffer.byteLength(JSON.stringify(ordinary)) }
  if (bytes() > 64000) {
    const original = value.text
    value.truncated = true
    const prefix = (length: number) => {
      value.text = original.slice(0, length)
      if (value.textRetention) value.textRetention.omittedBytes = value.textRetention.admittedBytes - Buffer.byteLength(value.text)
    }
    let low = 0, high = original.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2); prefix(middle)
      if (bytes() <= 64000) low = middle
      else high = middle - 1
    }
    if (low && /[\uD800-\uDBFF]/.test(original[low - 1]!)) low--
    prefix(low)
    if (bytes() > 64000) throw new Error('Code Mode observation metadata exceeds its ordinary output budget')
  }
  return value
}
