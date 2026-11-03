/** Conservative heuristic, not a provider tokenizer: ASCII UTF8 bytes / 3,
 * non-ASCII UTF8 bytes / 1 (covers multilingual/code text), rounded up.
 * Opaque data and images have explicit uncertainty; image allowances are not
 * provider bounds and never price base64 as ordinary text. */
export function priceProjectedText(text: string): number {
  let ascii = 0, nonAscii = 0
  for (const char of text) {
    if (char.codePointAt(0)! < 128)
      ascii++
    else
      nonAscii += Buffer.byteLength(char)
  }
  return Math.ceil(ascii / 3 + nonAscii)
}
