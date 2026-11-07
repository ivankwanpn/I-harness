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
  let ascii = 0, cjk = 0, other = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0)!
    if (codePoint < 128) ascii++
    else if (isCjk(codePoint)) cjk++
    else other += Buffer.byteLength(char)
  }
  return Math.ceil(ascii / 3 + cjk + other)
}
