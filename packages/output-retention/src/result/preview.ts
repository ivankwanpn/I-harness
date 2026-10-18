export function boundedPreview(text: string, cap = 8192): string {
  let lower = 0, upper = Math.min(text.length, cap)
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    if (Buffer.byteLength(JSON.stringify(text.slice(0, middle))) <= cap) lower = middle
    else upper = middle - 1
  }
  if (lower && /[\uD800-\uDBFF]/.test(text[lower - 1]!)) lower--
  return text.slice(0, lower)
}
