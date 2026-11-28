/** Conservative heuristic, not a provider tokenizer.
 *
 * ASCII text is priced at UTF-8 bytes / 3. CJK ideographs, kana and Hangul are
 * priced at one token per character: real tokenizers land near 0.6-1 token per
 * character, so this stays conservative while avoiding the 3x over-count of
 * pricing raw UTF-8 bytes. Other non-ASCII text keeps the byte heuristic, and
 * opaque data and images have their own explicit uncertainty.
 */
const isCjk = (codePoint: number): boolean =>
  (codePoint >= 0x2e80 && codePoint <= 0x9fff) || (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0x3040 && codePoint <= 0x30ff) || (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
  (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
export function priceProjectedText(text: string): number {
  return priceProjectedBytes(text, Buffer.byteLength(text))
}

/** The projection records the UTF-8 length alongside its token estimate. */
export function priceProjectedBytes(text: string, utf8Bytes: number): number {
  if (utf8Bytes === text.length) return Math.ceil(utf8Bytes / 3)
  let ascii = 0, cjkDiscount = 0
  for (let index = 0; index < text.length; index++) {
    const codePoint = text.codePointAt(index)!
    if (codePoint < 128) { ascii++; continue }
    // A CJK code point costs one token instead of three or four UTF-8 bytes.
    if (isCjk(codePoint)) cjkDiscount += codePoint > 0xffff ? 3 : 2
    if (codePoint > 0xffff) index++
  }
  return Math.ceil(ascii / 3) + utf8Bytes - ascii - cjkDiscount
}
