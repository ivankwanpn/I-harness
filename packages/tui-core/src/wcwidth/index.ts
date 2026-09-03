// M36: vendored terminal column-width semantics for a single code point.
// Sorted hand-written range tables + binary search (Kuhn-style wcwidth;
// whole box-drawing block U+2500-U+257F stays 1 — grok's "━━" timeline tick
// is TWO width-1 cells, not one width-2 grapheme; U+301C is 2 in CJK context;
// U+276F stays 1).

const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritics
  [0x0483, 0x0489], // Cyrillic combining
  [0x200b, 0x200f], // ZWSP/ZWNJ/ZWJ/LRM/RLM
  [0x20d0, 0x20f0], // combining diacriticals for symbols (enclosing)
  [0xfe00, 0xfe0f], // variation selectors
  [0xe0000, 0xe0fff], // supplementary private use / variation tages
]

const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a], // angle brackets
  [0x2e80, 0xa4cf], // CJK radicals/punct/ideographs/Yi (incl. U+301C, U+26A0 stays 1: below)
  [0xa960, 0xa97f], // Hangul Jamo ext-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility
  [0xfe10, 0xfe19], // vertical presentation forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f000, 0x1f02f], // mahjong tiles
  [0x1f300, 0x1f64f], // emoji/symbols (uch: U+1F600)
  [0x1f900, 0x1f9ff], // supplemental symbols
  [0x20000, 0x2fffd], // CJK ext B+
  [0x30000, 0x3fffd], // CJK ext G+
]

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = ranges[mid]
    if (cp < start) hi = mid - 1
    else if (cp > end) lo = mid + 1
    else return true
  }
  return false
}

/** Column width of a single code point: 0 (combining/control), 1 (narrow/ambiguous), 2 (wide). */
export function wcwidth(ch: string): 0 | 1 | 2 {
  const cp = ch.codePointAt(0)
  if (cp === undefined) return 1
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return 0
  if (inRanges(cp, ZERO_WIDTH)) return 0
  if (inRanges(cp, WIDE)) return 2
  return 1
}

/** Width of a full grapheme cluster: the base character width, never below 1. */
export function clusterWidth(grapheme: string): 1 | 2 {
  const w = wcwidth(grapheme)
  return w === 0 ? 1 : w
}
