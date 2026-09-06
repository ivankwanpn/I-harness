// M49 Task 7: grapheme segmentation — `Intl.Segmenter` (Unicode grapheme
// clusters, the baseline) with a code-point fallback when the API is
// unavailable. NEVER UTF-16 code units — the PromptEditor's cursor index
// lands on a grapheme boundary of its value string.

interface SegmenterCtor {
  new (locale: undefined, options: { granularity: "grapheme" }): { segment(text: string): Iterable<{ segment: string }> }
}

const segmenter: { segment(text: string): Iterable<{ segment: string }> } | undefined =
  typeof (Intl as { Segmenter?: SegmenterCtor }).Segmenter === "function"
    ? new (Intl as { Segmenter: SegmenterCtor }).Segmenter(undefined, { granularity: "grapheme" })
    : undefined

/** The grapheme clusters of `text` ([] for ""). */
export function graphemesOf(text: string): string[] {
  if (text === "") return []
  if (segmenter === undefined) return [...text] // code-point fallback
  const out: string[] = []
  for (const seg of segmenter.segment(text)) out.push(seg.segment)
  return out
}

/** The grapheme-boundary string indices of `text` ([0..length], inclusive). */
export function graphemeBounds(text: string): number[] {
  const bounds: number[] = [0]
  let acc = 0
  for (const g of graphemesOf(text)) {
    acc += g.length
    bounds.push(acc)
  }
  return bounds
}

/** True when `c` is a word-break separator (whitespace — the editor's word
 * boundary: simple and CJK-safe enough: spaces/newlines delimit words). */
export function isWordSep(c: string | undefined): boolean {
  if (c === undefined) return true
  return /\s/u.test(c)
}
