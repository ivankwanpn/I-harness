// Han, kana and Hangul ranges used by projected-pricing-v2, including
// supplementary ideographs. Preserve the established price for other scripts.
const isCjk = (codePoint: number): boolean =>
  (codePoint >= 0x2e80 && codePoint <= 0x9fff) || (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7af) || (codePoint >= 0x20000 && codePoint <= 0x2fa1f)

/** Price one text block. The prepared projection already measured its bytes. */
export function estimateUtf8Text(text: string, asciiCharsPerToken: number, utf8Bytes = Buffer.byteLength(text)): number {
  if (utf8Bytes === text.length) return Math.ceil(utf8Bytes / asciiCharsPerToken)
  let ascii = 0, cjkDiscount = 0
  for (let index = 0; index < text.length; index++) {
    const codePoint = text.codePointAt(index)!
    if (codePoint < 128) { ascii++; continue }
    // A CJK code point costs one token instead of three or four UTF-8 bytes.
    if (isCjk(codePoint)) cjkDiscount += codePoint > 0xffff ? 3 : 2
    if (codePoint > 0xffff) index++
  }
  return Math.ceil(ascii / asciiCharsPerToken) + utf8Bytes - ascii - cjkDiscount
}
