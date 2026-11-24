/** SQLite's tokenizer and JS use different Unicode case tables. Index an
 * exact, case-sensitive projection for candidate selection, then run the
 * shared JS matcher on the original text (which also owns snippet offsets).
 * Under Unicode /iu the ASCII letters also match long s and Kelvin sign. */
export function candidateText(text: string): string {
  return text.replace(/[A-Z\u017f\u212a\u0000]/g, char => {
    if (char === "\u017f") return "s"
    if (char === "\u0000") return "\ufffd"
    return char.toLowerCase()
  })
}

export function candidateExpression(query: string): string | undefined {
  const grams = new Set<string>()
  for (const word of candidateText(query).split(/\s+/u)) {
    let previous = ""
    let last = ""
    for (const char of word) {
      // A non-ASCII cased character may have additional /iu equivalents
      // which SQLite doesn't fold alike. Use other guaranteed grams, or scan.
      if (char.charCodeAt(0) >= 128 && /\p{Cased}/iu.test(char)) {
        previous = last = ""
        continue
      }
      if (previous) grams.add(previous + last + char)
      previous = last
      last = char
      if (grams.size >= 12) break
    }
    if (grams.size >= 12) break
  }
  if (grams.size === 0) return undefined
  return [...grams].map(gram => '"' + gram.replaceAll('"', '""') + '"').join(" AND ")
}
